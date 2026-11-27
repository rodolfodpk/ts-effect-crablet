// Runs under Node (Testcontainers). Decision V5: a leader given its application's name (`LeaderOptions.application`) reports a lock held by a session of
// ANOTHER application, once per holder; a standby of its own application says nothing. Two products on one database fight over the same fixed locks,
// and the second would otherwise stand by for ever, without an error.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Logger, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { tryAcquireGlobalLeader, type LeaderHandle } from "../../src/Leader.ts";
import { type ProcessConnections, ProcessConnectionsLive } from "../../src/ProcessConnections.ts";

type Rt = ManagedRuntime.ManagedRuntime<SqlClient.SqlClient | ProcessConnections, never>;
let db: TestDb;
const runtimes: Array<Rt> = [];
const OTHER_USER = "crablet_other_user";

before(async () => {
  db = await startTestDb();
  const admin = runtimeAs("setup/1");
  await admin.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.andThen(
        sql.unsafe(`CREATE ROLE ${OTHER_USER} LOGIN PASSWORD 'other'`),
        sql.unsafe(`GRANT CONNECT ON DATABASE "${db.connInfo.database}" TO ${OTHER_USER}`)
      )
    )
  );
}, { timeout: 60_000 });
after(async () => {
  for (const rt of runtimes) await rt.dispose();
  await db.stop();
});

function runtimeAs(applicationName: string, user: { readonly username: string; readonly password: string } = { username: db.connInfo.username, password: db.connInfo.password }): Rt {
  const rt = ManagedRuntime.make(
    Layer.merge(
      PgClient.layer({
        host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: user.username, password: Redacted.make(user.password), applicationName
      }).pipe(Layer.orDie),
      ProcessConnectionsLive
    )
  );
  runtimes.push(rt);
  return rt;
}

const fast = { heartbeat: "100 millis", verifyTimeout: "500 millis", failuresBeforeLost: 2 } as const;
// Tries `key` as `application`, and returns what it got and what it logged about the holder.
const attempt = async (rt: Rt, key: bigint, application: string | undefined) => {
  const lines: Array<{ level: string; message: string }> = [];
  const capture = Logger.layer([Logger.make((options) => void lines.push({ level: options.logLevel, message: String(options.message) }))], { mergeWithExisting: false });
  const handle = await rt.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => tryAcquireGlobalLeader(sql, key, { ...fast, application })).pipe(Effect.provide(capture))
  );
  return { handle, lines: lines.filter((l) => l.message.includes(`lock ${key}`)) };
};
let nextKey = 9200000000000000101n;
const aKey = () => nextKey++;

describe("a lock held by another product (decision V5)", () => {
  it("is reported as an error naming the holder, once per holder, however often the module retries", { timeout: 30_000 }, async () => {
    const key = aKey();
    const wallet = await attempt(runtimeAs("wallet/w-1"), key, "wallet");
    assert.ok(wallet.handle !== null, "the wallet leads");
    const course = runtimeAs("course/c-1");
    const first = await attempt(course, key, "course");
    assert.strictEqual(first.handle, null, "the course stands by");
    assert.strictEqual(first.lines.length, 1);
    assert.strictEqual(first.lines[0]!.level, "Error");
    assert.match(first.lines[0]!.message, /held by "wallet\/w-1"/u);
    assert.match(first.lines[0]!.message, /not by an instance of "course"/u);
    const again = await attempt(course, key, "course");
    assert.deepStrictEqual(again.lines, [], "the same holder is not reported twice");
    await runtimes[runtimes.length - 2]!.runPromise((wallet.handle as LeaderHandle).release());
  });

  it("a standby of the same product says nothing", { timeout: 30_000 }, async () => {
    const key = aKey();
    const leader = await attempt(runtimeAs("wallet/w-2"), key, "wallet");
    assert.ok(leader.handle !== null);
    const standby = await attempt(runtimeAs("wallet/w-3"), key, "wallet");
    assert.strictEqual(standby.handle, null);
    assert.deepStrictEqual(standby.lines, []);
  });

  it("without the application's name, nothing is looked up", { timeout: 30_000 }, async () => {
    const key = aKey();
    assert.ok((await attempt(runtimeAs("wallet/w-4"), key, "wallet")).handle !== null);
    const unnamed = await attempt(runtimeAs("course/c-2"), key, undefined);
    assert.strictEqual(unnamed.handle, null);
    assert.deepStrictEqual(unnamed.lines, []);
  });

  it("a holder of another database user is still named: only its query is hidden without pg_read_all_stats", { timeout: 30_000 }, async () => {
    const key = aKey();
    assert.ok((await attempt(runtimeAs("wallet/w-5"), key, "wallet")).handle !== null);
    const other = await attempt(runtimeAs("course/c-3", { username: OTHER_USER, password: "other" }), key, "course");
    assert.strictEqual(other.handle, null);
    assert.strictEqual(other.lines.length, 1);
    assert.strictEqual(other.lines[0]!.level, "Error");
    assert.match(other.lines[0]!.message, /held by "wallet\/w-5"/u);
  });

  it("a holder that names no application (a process given no product) is reported as a warning", { timeout: 30_000 }, async () => {
    const key = aKey();
    assert.ok((await attempt(runtimeAs(""), key, undefined)).handle !== null);
    const course = await attempt(runtimeAs("course/c-4"), key, "course");
    assert.strictEqual(course.handle, null);
    assert.strictEqual(course.lines.length, 1);
    assert.strictEqual(course.lines[0]!.level, "Warn");
    assert.match(course.lines[0]!.message, /names no application/u);
  });
});
