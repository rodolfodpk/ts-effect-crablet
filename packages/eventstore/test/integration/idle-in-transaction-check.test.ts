// Runs under Node (Testcontainers). The check reads the setting the application's sessions run with: Postgres's default (0, off) warns; one set on
// the session (here a startup parameter; a role's or the server's reads the same) says nothing. Why it matters: views/test/integration/zombie-transaction.test.ts.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Logger, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { checkIdleInTransactionOnce } from "../../src/ServerSettings.ts";

type Rt = ManagedRuntime.ManagedRuntime<PgClient.PgClient | SqlClient.SqlClient, never>;
let db: TestDb;

const runtimeWith = (startupParameters?: Record<string, string>): Rt =>
  ManagedRuntime.make(PgClient.layer({
    host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password),
    ...(startupParameters === undefined ? {} : { startupParameters })
  }) as unknown as Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, never>);

before(async () => {
  db = await startTestDb();
}, { timeout: 60_000 });
after(async () => {
  await db.stop();
});

const warningsOn = async (rt: Rt) => {
  const lines: Array<unknown> = [];
  const capture = Logger.layer([Logger.make((options) => void lines.push(options.message))], { mergeWithExisting: false });
  await rt.runPromise(Effect.flatMap(SqlClient.SqlClient, checkIdleInTransactionOnce).pipe(Effect.provide(capture)));
  return lines.map(String).filter((l) => l.includes("idle_in_transaction_session_timeout"));
};

describe("the idle-in-transaction check against Postgres", () => {
  it("Postgres's default (0, off) warns", async () => {
    const rt = runtimeWith();
    try {
      assert.strictEqual((await warningsOn(rt)).length, 1);
    } finally {
      await rt.dispose();
    }
  });

  it("a timeout the sessions run with says nothing", async () => {
    const rt = runtimeWith({ idle_in_transaction_session_timeout: "15000" });
    try {
      assert.strictEqual((await warningsOn(rt)).length, 0);
    } finally {
      await rt.dispose();
    }
  });
});
