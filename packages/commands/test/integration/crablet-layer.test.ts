// Runs under Node (Testcontainers). `Crablet.layer`: one layer from a Postgres config to a working
// framework, with the database clients still available in its output.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore } from "@crablet/eventstore";
import { CommandAuditStore } from "@crablet/eventstore/CommandAuditStore";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { defineCommand, emit } from "../../src/Command.ts";
import { defineEvent } from "../../src/Event.ts";

let db: TestDb;
before(async () => {
  db = await startTestDb();
}, { timeout: 60_000 });
after(async () => {
  await db.stop();
});

const Noted = defineEvent("Noted", { schema: Schema.Struct({ id: Schema.String }), tags: (d) => ({ note_id: d.id }) });
const Note = defineCommand({ name: "note", input: Schema.Struct({ id: Schema.String }), decide: (_, c) => emit(Noted(c)) });

describe("Crablet.layer", () => {
  it("provides a working executor and event store from a bare Postgres config", async () => {
    const AppLive = Crablet.layer({
      host: db.connInfo.host,
      port: db.connInfo.port,
      database: db.connInfo.database,
      username: db.connInfo.username,
      password: Redacted.make(db.connInfo.password)
    });
    const id = crypto.randomUUID();
    const exists = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const executor = yield* CommandExecutor;
          yield* executor.run(Note, { id });
          const eventStore = yield* EventStore;
          return yield* eventStore.exists(Noted.where({ note_id: id }));
        }),
        AppLive
      )
    );
    assert.equal(exists, true);
  });

  it("keeps SqlClient and PgClient in the output (the provide-vs-provideMerge trap)", async () => {
    const AppLive = Crablet.layer({
      host: db.connInfo.host,
      port: db.connInfo.port,
      database: db.connInfo.database,
      username: db.connInfo.username,
      password: Redacted.make(db.connInfo.password)
    });
    const services = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const pg = yield* PgClient.PgClient;
          const audit = yield* CommandAuditStore;
          const rows = yield* sql`SELECT 1 AS one`;
          return { one: rows[0]?.["one"], hasPg: pg !== undefined, hasAudit: audit !== undefined };
        }),
        AppLive
      )
    );
    assert.deepEqual(services, { one: 1, hasPg: true, hasAudit: true });
  });
});
