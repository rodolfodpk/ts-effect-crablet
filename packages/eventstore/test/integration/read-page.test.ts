// Runs under Node (Testcontainers). A paged read never skips an event (ADR-0050): a transaction with a LOWER id (T2) writes and commits after one with
// a higher id (T1). While T2 is open, the page does not return T1 (it is not settled: an event of T2 could still appear before it); once T2 commits,
// the next page from the same cursor returns both, T2's first. Without the settled bound, the cursor would move past T1 and T2's event, committed
// later at a lower (transaction id, position), would never be read: the inversion ADR-0012 measured for the pollers.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "../../src/EventStore.ts";
import * as AppendEvent from "../../src/AppendEvent.ts";
import * as Query from "../../src/Query.ts";
import * as Cursor from "../../src/Cursor.ts";

let db: TestDb;
let layer: Layer.Layer<EventStore | SqlClient.SqlClient, never>;
before(async () => {
  db = await startTestDb();
  const pg = PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
  layer = Layer.provideMerge(EventStoreLive, pg) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient, never>;
}, { timeout: 60_000 });
after(async () => { await db.stop(); });

const run = <A, E>(effect: Effect.Effect<A, E, EventStore | SqlClient.SqlClient>) => Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

describe("a paged read", () => {
  it("does not return an event while an older transaction is open, and then returns both in order: no event is skipped", { timeout: 60_000 }, async () => {
    const id = crypto.randomUUID();
    const q = Query.of(Query.queryItemOf([], [{ key: "page", value: id }]));
    const t2 = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
    await t2.connect();
    try {
      await t2.query("BEGIN");
      await t2.query("SELECT pg_current_xact_id()"); // T2 has the lower id
      await t2.query("INSERT INTO crablet_events (type, tags, data, transaction_id) VALUES ('PageT2', ARRAY[$1]::text[], '{}'::jsonb, pg_current_xact_id())", [`page=${id}`]);
      await run(Effect.flatMap(EventStore, (es) => es.append([AppendEvent.of("PageT1", "page", id, {})]))); // T1: higher id, committed

      const first = await run(Effect.flatMap(EventStore, (es) => es.read(q)));
      assert.deepStrictEqual(first.events.map((e) => e.type), [], "T1 is not settled while T2 is open");
      assert.strictEqual(first.more, false);

      await t2.query("COMMIT");
      const next = await run(Effect.flatMap(EventStore, (es) => es.read(q, { after: first.cursor })));
      assert.deepStrictEqual(next.events.map((e) => e.type), ["PageT2", "PageT1"], "both, in (transaction id, position) order");
      assert.notStrictEqual(Cursor.toString(next.cursor), Cursor.toString(first.cursor));
    } finally {
      await t2.end();
    }
  });
});
