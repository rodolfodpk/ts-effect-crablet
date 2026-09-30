// Runs under Node (Testcontainers). The shared conformance cases against real Postgres.
import { after, before, describe, it } from "node:test";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "../../src/EventStore.ts";
import { cases } from "../conformance/cases.ts";

let db: TestDb;
let layer: Layer.Layer<EventStore, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  layer = Layer.provide(EventStoreLive, pgLayer) as unknown as Layer.Layer<EventStore, never>;
}, { timeout: 60_000 });

after(async () => {
  await db.stop();
});

describe("EventStore conformance: Postgres", () => {
  for (const c of cases) {
    it(c.name, () => c.run({ run: (effect) => Effect.runPromise(Effect.provide(effect, layer)) }));
  }
});
