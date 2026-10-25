// Runs under Node (the docker CLI). A leader leads only on a primary (ADR-0045, decision 6). After a failover a client can reach the old writer, now a
// replica, through a cached DNS name; on a hot standby an advisory lock can still be taken (checked below), but no write succeeds there. So taking the
// lock asks for a primary first, and the heartbeat's check requires one too.
//
// One container runs a primary and a streaming replica of it (pg_basebackup -R) on a second port.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { tryAcquireGlobalLeader } from "../../src/Leader.ts";

const PASSWORD = "replica-test";
let container: string;
let primaryPort: number;
let replicaPort: number;

const docker = (...args: ReadonlyArray<string>) => execFileSync("docker", args as Array<string>).toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const portOf = (inner: number) => Number(docker("port", container, `${inner}/tcp`).split("\n")[0]!.split(":").pop());

before(async () => {
  container = docker("run", "-d", "--rm", "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-p", "127.0.0.1::5432", "-p", "127.0.0.1::5433", "postgres:18.6-alpine");
  for (let i = 0; i < 60; i++) {
    try { docker("exec", container, "pg_isready", "-h", "127.0.0.1", "-q"); break; } catch { await sleep(500); }
  }
  // The initdb run of the image restarts the server once: wait until it answers over TCP as the final server.
  for (let i = 0; i < 60; i++) {
    try { docker("exec", "-u", "postgres", container, "psql", "-h", "127.0.0.1", "-tAc", "SELECT 1"); break; } catch { await sleep(500); }
  }
  docker(
    "exec", "-u", "postgres", "-e", `PGPASSWORD=${PASSWORD}`, container, "sh", "-c",
    "pg_basebackup -h 127.0.0.1 -U postgres -D /tmp/replica -R -X stream && chmod 700 /tmp/replica && pg_ctl -D /tmp/replica -o '-p 5433' -l /tmp/replica.log -w start"
  );
  primaryPort = portOf(5432);
  replicaPort = portOf(5433);
}, { timeout: 120_000 });
after(() => {
  try { docker("stop", "-t", "1", container); } catch { /* it removes itself */ }
});

const client = async (port: number) => {
  const c = new Client({ host: "127.0.0.1", port, user: "postgres", password: PASSWORD, database: "postgres" });
  await c.connect();
  return c;
};
const runtimeOn = (port: number) =>
  ManagedRuntime.make(PgClient.layer({ host: "127.0.0.1", port, database: "postgres", username: "postgres", password: Redacted.make(PASSWORD) }) as unknown as Layer.Layer<SqlClient.SqlClient, never>);
const fast = { heartbeat: "200 millis", verifyTimeout: "500 millis", failuresBeforeLost: 2 } as const;

describe("a leader leads only on a primary (ADR-0045)", () => {
  it("on a hot standby an advisory lock CAN be taken: why the check is needed", { timeout: 30_000 }, async () => {
    const c = await client(replicaPort);
    try {
      const { rows } = await c.query<{ recovery: boolean; got: boolean }>("SELECT pg_is_in_recovery() AS recovery, pg_try_advisory_lock(4242) AS got");
      assert.deepStrictEqual(rows[0], { recovery: true, got: true });
    } finally {
      await c.end();
    }
  });

  it("the leader's attempt takes nothing on a replica, and leads on the primary", { timeout: 30_000 }, async () => {
    const replica = runtimeOn(replicaPort);
    const primary = runtimeOn(primaryPort);
    try {
      const onReplica = await replica.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => tryAcquireGlobalLeader(sql, 99n, fast)));
      assert.strictEqual(onReplica, null, "no leader on a replica");
      const held = await replica.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")));
      assert.strictEqual(held[0]!.n, 0, "and no lock was taken there");

      const onPrimary = await primary.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => tryAcquireGlobalLeader(sql, 99n, fast)));
      assert.ok(onPrimary !== null && onPrimary.isLeader());
      await sleep(1_000);
      assert.ok(onPrimary.isLeader(), "a leader on the primary keeps leading");
      await primary.runPromise(onPrimary.release());
    } finally {
      await replica.dispose();
      await primary.dispose();
    }
  });

  it("the heartbeat's check fails on a replica even for a session that holds the lock there", { timeout: 30_000 }, async () => {
    // The case the check guards: a lock session on a server that is (or became) a replica. Taken by hand, then checked with the leader's own query.
    const c = await client(replicaPort);
    try {
      await c.query("SELECT pg_try_advisory_lock(77)");
      const own = "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid() AND ((classid::bigint << 32) | objid::bigint) = $1::bigint";
      assert.strictEqual((await c.query(own, ["77"])).rowCount, 1, "the session does hold the lock");
      assert.strictEqual((await c.query(`${own} AND NOT pg_is_in_recovery()`, ["77"])).rowCount, 0, "but the leader's check says it does not lead");
    } finally {
      await c.end();
    }
  });
});
