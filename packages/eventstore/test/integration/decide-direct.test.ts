// Runs under Node (Testcontainers). The read a decision is made on, used directly (ADR-0050): its position carries the read's snapshot, so an
// unrelated transaction left open elsewhere does not make the append conflict on events the read saw (ADR-0048). Before the position carried it,
// a direct `AppendCondition.of(logPosition, query)` failed here, as commands did before ADR-0048.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive, readToDecide } from "../../src/EventStore.ts";
import * as AppendEvent from "../../src/AppendEvent.ts";
import * as AppendCondition from "../../src/AppendCondition.ts";
import * as Query from "../../src/Query.ts";

let db: TestDb;
let layer: Layer.Layer<EventStore | SqlClient.SqlClient, never>;
before(async () => {
  db = await startTestDb();
  const pg = PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
  layer = Layer.provideMerge(EventStoreLive, pg) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient, never>;
}, { timeout: 60_000 });
after(async () => { await db.stop(); });

const run = <A, E>(effect: Effect.Effect<A, E, EventStore | SqlClient.SqlClient>) => Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

describe("a decision made directly on the event store", () => {
  it("with an unrelated transaction open, an append after readToDecide is not a conflict on events the read saw", { timeout: 60_000 }, async () => {
    const id = crypto.randomUUID();
    const q = Query.forEventAndTag("DirectOpened", "direct_id", id);
    const other = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_current_xact_id()"); // holds xmin back: what is written after it is not settled
      const exit = await run(
        Effect.exit(
          Effect.gen(function* () {
            const es = yield* EventStore;
            yield* es.append([AppendEvent.of("DirectOpened", "direct_id", id, {})]);
            const { events, position } = yield* readToDecide(q);
            assert.strictEqual(events.length, 1);
            return yield* es.append([AppendEvent.of("DirectDone", "direct_id", id, {})], AppendCondition.failIfEventsMatch(q, { after: position }));
          })
        )
      );
      assert.strictEqual(exit._tag, "Success", `the append conflicted on an event the read had seen: ${String(exit)}`);
    } finally {
      await other.query("ROLLBACK");
      await other.end();
    }
  });
});
