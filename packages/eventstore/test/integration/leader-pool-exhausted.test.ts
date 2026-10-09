// Runs under Node (Testcontainers) - see NOTES.md. A leader reserves a connection from the client's pool and holds it. When the pool has none to give (its connections are all held: by other
// leaders, by the LISTENs, which with @effect/sql-pg take one each), `reserve` used to wait for ever, silently: the module never led, and nothing said why. Found behind PgBouncer, with a
// session pool of 5 against the 7 connections a process holds for good (3 leader locks, 4 LISTEN). Now the wait has a limit and fails with a message that names the pool, and it gives back
// whatever it had taken, so a later attempt, once a connection is free, works.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { tryAcquireGlobalLeader } from "../../src/Leader.ts";

let db: TestDb;
before(async () => { db = await startTestDb(); }, { timeout: 60_000 });
after(async () => { await db.stop(); });

const newKey = () => BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);
const runtimeWithPool = (maxConnections: number) =>
  ManagedRuntime.make(
    PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), maxConnections }) as unknown as Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, never>
  );

describe("a leader whose pool has no connection to give", () => {
  it("fails within the limit, saying the pool is the reason, and a later attempt works once a connection is free", { timeout: 30_000 }, async () => {
    const rt = runtimeWithPool(2);
    try {
      // two other leaders hold both connections of the pool for good
      const holdA = await rt.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => tryAcquireGlobalLeader(sql, newKey())));
      const holdB = await rt.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => tryAcquireGlobalLeader(sql, newKey())));
      assert.ok(holdA !== null && holdB !== null);

      const started = Date.now();
      const exit = await rt.runPromiseExit(Effect.flatMap(SqlClient.SqlClient, (sql) => tryAcquireGlobalLeader(sql, newKey(), { reserveTimeout: "400 millis" })));
      const took = Date.now() - started;
      assert.strictEqual(exit._tag, "Failure", "it did not wait for ever");
      assert.ok(took >= 350 && took < 5_000, `it gave up at the limit (took ${took} ms)`);
      assert.match(JSON.stringify(exit), /no connection|pool|maxConnections/i, "and the message names the pool");

      // nothing was left taken by the attempt that gave up: free one connection and the next attempt gets it at once
      await rt.runPromise(holdA!.release());
      const later = await rt.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => tryAcquireGlobalLeader(sql, newKey(), { reserveTimeout: "2 seconds" })));
      assert.ok(later !== null, "a leader can be taken once a connection is free");
      await rt.runPromise(later!.release());
      await rt.runPromise(holdB!.release());
    } finally {
      await rt.dispose();
    }
  });

  it("gives back the connection it took when its first statement fails, instead of keeping the pool slot", { timeout: 30_000 }, async () => {
    const rt = runtimeWithPool(1);
    try {
      // a key outside the range of a bigint: the connection is reserved, then pg_try_advisory_lock fails ("out of range")
      const bad = await rt.runPromiseExit(Effect.flatMap(SqlClient.SqlClient, (sql) => tryAcquireGlobalLeader(sql, 2n ** 70n, { reserveTimeout: "2 seconds" })));
      assert.strictEqual(bad._tag, "Failure", "the statement failed");
      // a pool of one: if the failed attempt had kept its slot, this would wait for the limit and fail
      const handle = await rt.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => tryAcquireGlobalLeader(sql, newKey(), { reserveTimeout: "2 seconds" })));
      assert.ok(handle !== null, "the slot was given back");
      await rt.runPromise(handle!.release());
    } finally {
      await rt.dispose();
    }
  });
});
