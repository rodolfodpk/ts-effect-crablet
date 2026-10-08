// Runs under Node (Testcontainers). The poller's key-presence selections (requiredTags / anyOfTags) answered from the derived tag table and from the events' own
// `tags` array must select EXACTLY the same events and give the same "anything pending" answer, for any selection and any cursor, on data written through the real
// append path with concurrent transactions (so transaction ids and positions are out of order). A precondition for dropping the tag table
// (docs/adr/0019-storage-visibility-and-the-tag-table.md): if this fails, the table cannot be dropped as is.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { hasPendingSelectedEvents, makeSqlEventFetcher } from "../../src/SqlEventFetcher.ts";
import * as EventSelection from "../../src/EventSelection.ts";
import * as ProgressCursorNS from "../../src/ProgressCursor.ts";
import type { TagKeyStrategy } from "../../src/internal/sql.ts";

let db: TestDb;
let layer: Layer.Layer<EventStore | SqlClient.SqlClient, never>;
before(async () => {
  db = await startTestDb();
  layer = Layer.provideMerge(
    EventStoreLive,
    PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) })
  ) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient, never>;
}, { timeout: 60_000 });
after(async () => { await db.stop(); });
const run = <A, E>(e: Effect.Effect<A, E, EventStore | SqlClient.SqlClient>) => Effect.runPromise(Effect.provide(e, layer) as Effect.Effect<A, E, never>);

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const KEYS = ["a", "b", "c", "d", "e", "f"];
const TYPES = ["T1", "T2", "T3", "T4"];
// values include one with '=' in it and an empty one: the key is what is before the FIRST '='
const VALUES = ["x", "y", "", "p=q"];

describe("tag key presence: the tag table and the events' own tags select the same events", () => {
  it("random events written by concurrent transactions, random selections and cursors: identical fetches and identical pending answers", { timeout: 300_000 }, async () => {
    const random = mulberry32(20261007);
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(random() * xs.length)]!;
    const subset = <T>(xs: ReadonlyArray<T>, max: number): Array<T> => xs.filter(() => random() < 0.5).slice(0, max);

    const makeEvent = () => {
      const b = AppendEvent.builder(pick(TYPES));
      for (const key of subset(KEYS, 4)) b.tag(key, pick(VALUES));
      return b.data({ n: Math.floor(random() * 1000) }).build();
    };
    // 4 concurrent appenders, batches of 1-30: transaction ids and positions interleave
    const total = 2_400;
    const batches: Array<number> = [];
    for (let left = total; left > 0; ) { const n = Math.min(left, 1 + Math.floor(random() * 30)); batches.push(n); left -= n; }
    await run(Effect.gen(function* () {
      const es = yield* EventStore;
      yield* Effect.forEach(batches, (n) => es.append(Array.from({ length: n }, makeEvent)), { concurrency: 4 });
    }));

    // GUARANTEED inversions (not left to timing): transaction A takes its transaction id first, B then inserts and commits a row, and A inserts its row and
    // commits last, so A has the LOWER transaction id and the HIGHER position.
    const appendRaw = (c: Client, type: string, tag: string) => c.query("SELECT append_events_batch(ARRAY[$1], ARRAY[$2], ARRAY['{}'::jsonb], now(), NULL, NULL)", [type, `{${tag}}`]);
    const connect = async () => { const c = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password }); await c.connect(); return c; };
    const [a, b] = [await connect(), await connect()];
    try {
      for (let i = 0; i < 25; i++) {
        await a.query("BEGIN"); await a.query("SELECT pg_current_xact_id()");
        await appendRaw(b, "T1", `${pick(KEYS)}=x`); // autocommit: a higher transaction id, a lower position
        await appendRaw(a, "T2", `${pick(KEYS)}=y`);
        await a.query("COMMIT");
      }
    } finally { await Promise.all([a.end(), b.end()]); }
    const expectedTotal = total + 50;

    const rows = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<{ x: string; p: string }>("SELECT transaction_id::text AS x, position::text AS p FROM crablet_events ORDER BY transaction_id, position")));
    assert.strictEqual(rows.length, expectedTotal);
    // the data really has inversions: somewhere, ordering by transaction id disagrees with ordering by position
    let inversions = 0;
    for (let i = 1; i < rows.length; i++) if (BigInt(rows[i]!.p) < BigInt(rows[i - 1]!.p)) inversions++;
    assert.ok(inversions >= 25, `transaction ids and positions are out of order in at least the 25 constructed pairs: ${inversions}`);

    const cursorOf = (i: number | null) => (i === null ? ProgressCursorNS.zero : ProgressCursorNS.of(rows[i]!.x, BigInt(rows[i]!.p)));
    const selection = () =>
      EventSelection.of({
        eventTypes: new Set(random() < 0.5 ? subset(TYPES, 2) : []),
        requiredTags: new Set(random() < 0.4 ? subset([...KEYS, "zzz"], 2) : []),
        anyOfTags: new Set(random() < 0.6 ? subset([...KEYS, "zzz"], 3) : []),
        exactTags: new Map(random() < 0.25 ? [[pick(KEYS), pick(VALUES)] as const] : [])
      });

    const mismatches: Array<string> = [];
    let nonEmpty = 0, withKeyClauses = 0, pendingTrue = 0, pendingFalse = 0;
    for (let n = 0; n < 400; n++) {
      const sel = selection();
      const hasKeyClause = sel.requiredTags.size > 0 || sel.anyOfTags.size > 0;
      const after = random() < 0.3 ? null : Math.floor(random() * rows.length);
      const batch = 1 + Math.floor(random() * 150);
      const fetch = (tagKeys: TagKeyStrategy) =>
        run(Effect.flatMap(makeSqlEventFetcher<string>(sel, { tagKeys }), (f) => f.fetchEvents("p", cursorOf(after), batch)));
      const [viaTable, viaScan] = [await fetch("table"), await fetch("scan")];
      const shape = (xs: typeof viaTable) => xs.map((e) => `${e.position}:${e.type}:${e.tags.map((t) => `${t.key}=${t.value}`).join(",")}`);
      if (JSON.stringify(shape(viaTable)) !== JSON.stringify(shape(viaScan))) mismatches.push(`fetch #${n}: table ${viaTable.length} rows, scan ${viaScan.length} rows`);
      if (viaTable.length > 0) nonEmpty++;
      if (hasKeyClause) withKeyClauses++;

      const lo = after === null ? 0 : after, hi = Math.min(rows.length - 1, lo + Math.floor(random() * (random() < 0.6 ? 12 : 600))); // many short ranges, so "nothing pending" happens too
      const pending = (tagKeys: TagKeyStrategy) => run(hasPendingSelectedEvents(sel, cursorOf(after), cursorOf(hi), { tagKeys }));
      const [pTable, pScan] = [await pending("table"), await pending("scan")];
      if (pTable !== pScan) mismatches.push(`pending #${n}: table ${pTable}, scan ${pScan}`);
      if (pTable) pendingTrue++; else pendingFalse++;
    }
    assert.deepStrictEqual(mismatches, [], mismatches.slice(0, 5).join("; "));
    // the test is not vacuous: many selections returned rows, many used key clauses, and the pending answer went both ways
    assert.ok(nonEmpty > 100, `non-empty fetches: ${nonEmpty}`);
    assert.ok(withKeyClauses > 150, `selections with a key clause: ${withKeyClauses}`);
    assert.ok(pendingTrue > 30 && pendingFalse > 30, `pending answers: ${pendingTrue} true, ${pendingFalse} false`);
  });

  it("the scan form really does not use the tag table (it still answers when the tag rows are gone)", { timeout: 60_000 }, async () => {
    const r = await run(Effect.gen(function* () {
      const es = yield* EventStore;
      const sql = yield* SqlClient.SqlClient;
      yield* es.append([AppendEvent.builder("Marker").tag("only_here", "1").data({}).build()]);
      yield* sql.unsafe("DELETE FROM crablet_event_tag_keys WHERE key = 'only_here'");
      const sel = EventSelection.of({ requiredTags: new Set(["only_here"]) });
      const table = yield* Effect.flatMap(makeSqlEventFetcher<string>(sel, { tagKeys: "table" }), (f) => f.fetchEvents("p", ProgressCursorNS.zero, 10));
      const scan = yield* Effect.flatMap(makeSqlEventFetcher<string>(sel, { tagKeys: "scan" }), (f) => f.fetchEvents("p", ProgressCursorNS.zero, 10));
      return { table: table.length, scan: scan.length };
    }));
    assert.deepStrictEqual(r, { table: 0, scan: 1 });
  });
});
