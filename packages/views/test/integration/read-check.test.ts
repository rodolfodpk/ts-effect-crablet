// Runs under Node (Testcontainers) - see NOTES.md. `readCheck`: the first look of a consistent read in ONE statement (where the log ends, where each view is, whether anything the
// view handles is still pending) must give the verdict the three separate statements give: the head of the log, the view's progress row, and `hasPendingSelectedEvents`, run
// through the real `waitUntilProcessed` for the verdict. A fixed set of states, then random ones (the seed is printed; SEED=n repeats a run).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import * as ProgressCursor from "@crablet/event-poller/ProgressCursor";
import type { SelectionQueryOptions } from "@crablet/event-poller/SqlEventFetcher";
import { viewSubscriptionOf, type ViewSubscription } from "../../src/ViewSubscription.ts";
import { ViewFailed, WaitTimeout, waitUntilProcessed } from "../../src/WaitUntilProcessed.ts";
import { viewVerdict, type ViewVerdict } from "../../src/ViewVerdict.ts";
import { readCheck } from "../../src/ReadCheck.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | SqlClient.SqlClient | PgClient.PgClient, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
  runtime = ManagedRuntime.make(Layer.provideMerge(EventStoreLive, pgLayer) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient | PgClient.PgClient, never>);
}, { timeout: 60_000 });
after(async () => {
  await runtime.dispose();
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, EventStore | SqlClient.SqlClient | PgClient.PgClient>) => runtime.runPromise(effect);

// ---- the three separate statements, as the code did them (the verdict through the real waitUntilProcessed)
const referenceHead = () => run(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ x: string; p: string }>("SELECT transaction_id::text AS x, position::text AS p FROM crablet_events ORDER BY transaction_id DESC, position DESC LIMIT 1");
    return rows[0] === undefined ? ProgressCursor.zero : ProgressCursor.of(rows[0].x, BigInt(rows[0].p));
  })
);

// (waitUntilProcessed always tests tag keys against the key table; `scan` is the reference the key table must agree with, so the fused statement is asked with either.)
const reference = async (subscription: ViewSubscription, marker: ProgressCursor.ProgressCursor | null) => {
  const head = await referenceHead();
  const write = marker ?? head;
  const verdict: ViewVerdict = await run(
    Effect.match(waitUntilProcessed(subscription, write, { timeout: "30 millis" }), {
      onFailure: (e) => (e instanceof ViewFailed ? ("failed" as const) : e instanceof WaitTimeout ? ("wait" as const) : (() => { throw e; })()),
      onSuccess: () => "caught_up" as const
    })
  );
  return { head, verdict };
};

const setProgress = (view: string, cursor: ProgressCursor.ProgressCursor | null, status: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("DELETE FROM crablet_view_progress WHERE view_name = $1", [view]);
      if (cursor !== null) {
        yield* sql.unsafe("INSERT INTO crablet_view_progress (view_name, status, last_position, last_transaction_id) VALUES ($1, $2, $3::bigint, $4::xid8)", [view, status, cursor.position.toString(), cursor.transactionId]);
      }
    })
  );

const equal = async (subs: ReadonlyArray<ViewSubscription>, marker: ProgressCursor.ProgressCursor | null, options: SelectionQueryOptions, what: string) => {
  const fused = await run(readCheck(subs, marker, options));
  assert.strictEqual(fused.views.length, subs.length, `${what}: one entry per view`);
  const write = marker ?? fused.head;
  for (let i = 0; i < subs.length; i++) {
    const ref = await reference(subs[i]!, marker);
    const v = fused.views[i]!;
    assert.deepStrictEqual(fused.head, ref.head, `${what}: the head of the log`);
    assert.strictEqual(viewVerdict(write, v.cursor, v.status, v.pending), ref.verdict, `${what}: the verdict for ${subs[i]!.viewName} (cursor ${v.cursor.transactionId}:${v.cursor.position}, status ${v.status}, pending ${v.pending}, write ${write.transactionId}:${write.position})`);
  }
  return fused;
};

describe("readCheck gives the verdict the separate statements give", () => {
  it("an empty log: the head is the zero cursor, a view with no progress row is at zero with no status, and it has caught up", async () => {
    const sub = viewSubscriptionOf("rc-empty", { eventTypes: new Set(["T0"]) });
    const fused = await equal([sub], null, {}, "empty log");
    assert.deepStrictEqual(fused.head, ProgressCursor.zero);
    assert.deepStrictEqual(fused.views[0], { cursor: ProgressCursor.zero, status: null, pending: false });
    assert.deepStrictEqual((await run(readCheck([], null))).head, ProgressCursor.zero, "with no views, just the head");
  });

  it("random logs, selections, progress rows and markers (the seed is printed)", { timeout: 300_000 }, async () => {
    const seed = Number(process.env["SEED"] ?? Math.floor(Math.random() * 2 ** 31));
    console.log(`read-check seed: ${seed}`);
    let state = seed >>> 0;
    const rand = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(rand() * xs.length)]!;
    const subset = <T>(xs: ReadonlyArray<T>): T[] => xs.filter(() => rand() < 0.5);

    // a log: events of four types, each carrying some of the tag keys a, b, c with a small value
    const types = ["T0", "T1", "T2", "T3"], keys = ["a", "b", "c"], values = ["x", "y"];
    await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        for (let i = 0; i < 70; i++) {
          const b = AppendEvent.builder(pick(types));
          for (const k of subset(keys)) b.tag(k, pick(values));
          yield* store.append([b.data({ i }).build()]);
        }
      })
    );
    const cursors = await run(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<{ x: string; p: string }>("SELECT transaction_id::text AS x, position::text AS p FROM crablet_events ORDER BY transaction_id, position"))
    );
    const log = cursors.map((r) => ProgressCursor.of(r.x, BigInt(r.p)));
    const head = log[log.length - 1]!;

    const selection = (name: string): ViewSubscription => {
      const kind = pick(["types", "required", "anyOf", "exact", "empty", "types+any"]);
      const fields: Record<string, unknown> = {};
      if (kind === "types" || kind === "types+any") fields.eventTypes = new Set(subset(types).length === 0 ? [pick(types)] : subset(types));
      if (kind === "required") fields.requiredTags = new Set(subset(keys).length === 0 ? [pick(keys)] : subset(keys));
      if (kind === "anyOf" || kind === "types+any") fields.anyOfTags = new Set(subset(keys).length === 0 ? [pick(keys)] : subset(keys));
      if (kind === "exact") fields.exactTags = new Map([[pick(keys), pick(values)]]);
      return viewSubscriptionOf(name, fields as never);
    };

    let checked = 0;
    const seen = { caught_up: 0, wait: 0, failed: 0 };
    for (let round = 0; round < 120; round++) {
      const options: SelectionQueryOptions = { tagKeys: pick(["table", "scan"] as const) };
      const subs = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, i) => selection(`rc-${round}-${i}`));
      for (const s of subs) {
        // a progress row: none, somewhere in the log, the head, past the head; any status
        const where = pick(["none", "log", "log", "head", "past"] as const);
        const cursor = where === "none" ? null : where === "log" ? pick(log) : where === "head" ? head : ProgressCursor.of(String(BigInt(head.transactionId) + 5n), head.position + 100n);
        await setProgress(s.viewName, cursor, pick(["ACTIVE", "ACTIVE", "PAUSED", "FAILED"]));
      }
      const marker = pick<ProgressCursor.ProgressCursor | null>([null, null, head, pick(log), log[Math.max(0, log.length - 2)]!]);
      const fused = await equal(subs, marker, options, `round ${round} (seed ${seed}, tagKeys ${options.tagKeys})`);
      const write = marker ?? fused.head;
      for (const v of fused.views) seen[viewVerdict(write, v.cursor, v.status, v.pending)]++;
      checked += subs.length;
    }
    console.log(`read-check: ${checked} views compared; verdicts seen ${JSON.stringify(seen)}`);
    assert.ok(seen.caught_up > 0 && seen.wait > 0 && seen.failed > 0, "the random states reach all three verdicts, or the test proves little");
  });

  it("the same view twice, and a different order, are answered by position", async () => {
    const a = viewSubscriptionOf("rc-twice-a", { eventTypes: new Set(["T0"]) });
    const b = viewSubscriptionOf("rc-twice-b", { eventTypes: new Set(["T1"]) });
    await setProgress("rc-twice-a", null, "ACTIVE");
    await setProgress("rc-twice-b", ProgressCursor.zero, "PAUSED");
    const fused = await run(readCheck([a, b, a], null));
    assert.strictEqual(fused.views.length, 3);
    assert.strictEqual(fused.views[0]!.status, null);
    assert.strictEqual(fused.views[1]!.status, "PAUSED");
    assert.deepStrictEqual(fused.views[2], fused.views[0], "the second look at the same view says the same");
  });
});
