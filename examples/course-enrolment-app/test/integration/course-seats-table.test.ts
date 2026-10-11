// Runs under Node (Testcontainers). The seats view's declared table (src/views/CourseSeatsViewProjector.ts) must match the migrated database: a migration that renames or retypes a column fails here, not at the first event.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import * as Crablet from "@crablet/commands/Crablet";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { checkViewTables } from "@crablet/views/ViewTableCheck";
import { CourseSeatsView } from "../../src/views/CourseSeatsViewProjector.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient | PgClient.PgClient, never>;
before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  runtime = ManagedRuntime.make(
    Crablet.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) }) as unknown as Layer.Layer<SqlClient.SqlClient | PgClient.PgClient, never>
  );
}, { timeout: 60_000 });
after(async () => {
  await runtime.dispose();
  await db.stop();
});

describe("the seats view's declared table", () => {
  it("matches the migrated database", async () => {
    const problems = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => checkViewTables(sql, CourseSeatsView.tables)));
    assert.deepStrictEqual(problems, []);
  });
});
