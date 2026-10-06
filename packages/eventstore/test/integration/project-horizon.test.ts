// Runs under Node (Testcontainers) - see NOTES.md. `project` returns a horizon: a cursor before every event the read could have missed (ADR-0018, decision 8).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "../../src/EventStore.ts";
import * as Query from "../../src/Query.ts";
import * as LogPosition from "../../src/LogPosition.ts";

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

const noop = { eventTypes: [] as ReadonlyArray<string>, initialState: 0, transition: (n: number) => n };
const horizonOf = () =>
  Effect.runPromise(Effect.provide(Effect.flatMap(EventStore, (es) => es.project(Query.of([]), LogPosition.zero(), [noop])), layer) as Effect.Effect<any, never, never>).then((r) => r.horizon as LogPosition.LogPosition);

describe("project returns a horizon", () => {
  it("with nothing running, it is at or above every finished transaction; position 0, no timestamp", async () => {
    const h = await horizonOf();
    assert.strictEqual(h.position, 0n);
    assert.strictEqual(h.occurredAt, null);
    assert.ok(h.transactionId !== null && BigInt(h.transactionId) > 0n);
  });

  it("an open transaction pins it: the horizon is that transaction's id, so an event it later commits sorts after the cursor", async () => {
    const open = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
    await open.connect();
    try {
      await open.query("BEGIN");
      const xid = (await open.query("SELECT pg_current_xact_id()::text AS x")).rows[0].x as string;
      const h = await horizonOf();
      assert.strictEqual(h.transactionId, xid);
      await open.query("COMMIT");
      const later = await horizonOf();
      assert.ok(BigInt(later.transactionId!) > BigInt(xid));
    } finally {
      await open.end();
    }
  });
});
