// Runs under Node (Testcontainers) - see NOTES.md. The "is anything this selection matches still pending in (after, upTo]?" query (`buildPendingSelectionQuery`, behind `hasPendingSelectedEvents`, which the
// wait of a consistent read runs on every turn while a view is behind) must find the first match along the (transaction_id, position) index. Without an ORDER BY the planner took a Seq Scan of
// crablet_events for a typical view selection (4 to 8 ms on 100,000 events, growing with the log), and for a key present on every event a Seq Scan of crablet_event_tag_keys with one probe of
// the log per row (45 ms). A result cannot tell the two plans apart,
// so this test reads the plan. It needs a log big enough for the planner to prefer the index: 100,000 events.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import * as EventSelection from "../../src/EventSelection.ts";
import * as ProgressCursorNS from "../../src/ProgressCursor.ts";
import { hasPendingSelectedEvents } from "../../src/SqlEventFetcher.ts";
import { buildPendingSelectionQuery } from "../../src/internal/sql.ts";

const N = 100_000;
const WALLETS = 10_000;
let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | SqlClient.SqlClient, never>;

before(async () => {
  db = await startTestDb();
  runtime = ManagedRuntime.make(
    Layer.provideMerge(EventStoreLive, PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), maxConnections: 4 })) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient, never>
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const es = yield* EventStore;
      for (let start = 0; start < N; start += 50) {
        yield* es.append(
          Array.from({ length: 50 }, (_, k) => {
            const i = start + k;
            const wallet = `w${i % WALLETS}`;
            return i % 20 === 0
              ? AppendEvent.builder("MoneyTransferred").tag("from_wallet_id", wallet).tag("to_wallet_id", `w${(i * 7 + 1) % WALLETS}`).tag("year", "2026").data({ i }).build()
              : AppendEvent.builder("DepositMade").tag("wallet_id", wallet).tag("deposit_id", `d${i}`).tag("year", "2026").data({ i }).build();
          })
        );
      }
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("VACUUM ANALYZE crablet_events");
      yield* sql.unsafe("VACUUM ANALYZE crablet_event_tag_keys");
    })
  );
}, { timeout: 180_000 });
after(async () => {
  await runtime.dispose();
  await db.stop();
});

const q = <A extends object>(text: string, params: ReadonlyArray<unknown> = []) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(text, params as never)));

// the cursor of the event that is `behind` events before the end of the log
const behind = async (n: number) => {
  const r = (await q<{ x: string; p: string }>(`SELECT transaction_id::text AS x, position::text AS p FROM crablet_events ORDER BY transaction_id, position OFFSET ${N - n} LIMIT 1`))[0]!;
  return ProgressCursorNS.of(r.x, BigInt(r.p));
};

const selections: ReadonlyArray<readonly [string, EventSelection.EventSelection, number]> = [
  ["a view: its event types plus the wallet keys", EventSelection.of({ eventTypes: new Set(["DepositMade", "MoneyTransferred"]), anyOfTags: new Set(["wallet_id", "from_wallet_id", "to_wallet_id"]) }), 5_000],
  ["one event type that most events have", EventSelection.of({ eventTypes: new Set(["DepositMade"]) }), 5_000],
  ["a required key that every event has", EventSelection.of({ requiredTags: new Set(["year"]) }), 50_000],
  ["no restriction at all", EventSelection.of({}), 50_000]
];

describe("the pending query finds the first match along the index, not by scanning crablet_events", () => {
  for (const [label, selection, distance] of selections) {
    it(`${label}, ${distance.toLocaleString()} events behind: no Seq Scan, and it finds a match`, { timeout: 60_000 }, async () => {
      const end = await behind(1);
      const cursor = await behind(distance);
      const query = buildPendingSelectionQuery(selection, cursor, end);
      const plan = (await q<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF) ${query.sql}`, query.params)).map((r) => r["QUERY PLAN"]).join("\n");
      assert.ok(!/Seq Scan on crablet_(events|event_tag_keys)/.test(plan), `a Seq Scan of the event log or of its tag-key table:\n${plan}`);
      assert.strictEqual(await runtime.runPromise(hasPendingSelectedEvents(selection, cursor, end)), true, "something is pending in that range");
    });
  }

  it("nothing is pending when the cursor is at the end of the log", async () => {
    const end = await behind(1);
    for (const [, selection] of selections) assert.strictEqual(await runtime.runPromise(hasPendingSelectedEvents(selection, end, end)), false);
  });
});
