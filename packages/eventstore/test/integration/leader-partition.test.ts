// Runs under Node (Testcontainers). A silent network partition between the leader and Postgres (ADR-0045): no FIN, no RST, the packets just stop.
// The leader's connection goes through an in-process TCP proxy that, when cut, stops forwarding in both directions and closes nothing. The leader notices
// within its heartbeat's bound; the server, without help, would keep the session (and the lock) until its TCP keepalives give up. With the lock
// session's `idle_session_timeout`, the server ends it and a follower takes the lock.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { tryAcquireGlobalLeader, type LeaderHandle, type LeaderOptions } from "../../src/Leader.ts";

type Rt = ManagedRuntime.ManagedRuntime<PgClient.PgClient | SqlClient.SqlClient, never>;
let db: TestDb;
let direct: Rt;

const runtimeTo = (host: string, port: number, maxConnections?: number): Rt =>
  ManagedRuntime.make(PgClient.layer({
    host, port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password),
    ...(maxConnections === undefined ? {} : { maxConnections })
  }) as unknown as Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, never>);

before(async () => {
  db = await startTestDb();
  direct = runtimeTo(db.connInfo.host, db.connInfo.port);
}, { timeout: 60_000 });
after(async () => {
  await direct.dispose();
  await db.stop();
});

// A proxy to Postgres that can be cut silently, and then closed (so the cut side's pool can end).
const partitionableProxy = async () => {
  let cut = false;
  const sockets: Array<net.Socket> = [];
  const server = net.createServer((client) => {
    const upstream = net.connect(db.connInfo.port, db.connInfo.host);
    sockets.push(client, upstream);
    client.on("data", (d) => { if (!cut) upstream.write(d); });
    upstream.on("data", (d) => { if (!cut) client.write(d); });
    client.on("error", () => {});
    upstream.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    cut: () => { cut = true; },
    close: () => { for (const s of sockets) s.destroy(); server.close(); }
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newKey = () => BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);
const acquire = (rt: Rt, key: bigint, options: LeaderOptions) => rt.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => tryAcquireGlobalLeader(sql, key, options)));
const lockHeld = async (key: bigint) =>
  (await direct.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.unsafe<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND ((classid::bigint << 32) | objid::bigint) = $1::bigint", [key.toString()])
  )))[0]!.n === 1;

// Fast settings, so the test takes seconds: the leader is lost after at most 2 x (200 ms + 500 ms) = 1.4 s.
const fast = { heartbeat: "200 millis", verifyTimeout: "500 millis", failuresBeforeLost: 2 } as const;
const SERVER_IDLE_MS = 3_000;

// The leader through the proxy, a follower on a direct connection that tries every 200 ms, as a module's retry loop does. Cuts the proxy and returns
// when each side noticed, in ms after the cut (null: not within `watchMs`).
const partition = async (serverIdleTimeout: LeaderOptions["serverIdleTimeout"], watchMs: number) => {
  const proxy = await partitionableProxy();
  const rtA = runtimeTo("127.0.0.1", proxy.port);
  const key = newKey();
  let follower: LeaderHandle | null = null;
  try {
    const leader = (await acquire(rtA, key, { ...fast, serverIdleTimeout }))!;
    assert.ok(leader !== null && leader.isLeader());
    assert.strictEqual(await acquire(direct, key, fast), null, "the follower does not get the lock while the leader holds it");
    await sleep(1_000); // a few heartbeats: a live leader's session is never idle long enough
    assert.ok(leader.isLeader() && (await lockHeld(key)), "a heartbeating leader keeps its lock");

    proxy.cut();
    const cutAt = Date.now();
    let leaderLostMs: number | null = null;
    let followerLeadsMs: number | null = null;
    while (Date.now() - cutAt < watchMs && followerLeadsMs === null) {
      if (leaderLostMs === null && !leader.isLeader()) leaderLostMs = Date.now() - cutAt;
      follower = await acquire(direct, key, fast);
      if (follower !== null) followerLeadsMs = Date.now() - cutAt;
      else await sleep(200);
    }
    if (leaderLostMs === null && !leader.isLeader()) leaderLostMs = Date.now() - cutAt;
    return { leaderLostMs, followerLeadsMs, lockStillHeld: follower === null && (await lockHeld(key)) };
  } finally {
    if (follower !== null) await direct.runPromise(follower.release());
    proxy.close();
    await rtA.dispose().catch(() => {});
  }
};

describe("a silent partition between the leader and Postgres (ADR-0045)", () => {
  it("with the lock session's idle timeout, the server frees the lock and a follower leads, after the old leader has stopped", { timeout: 30_000 }, async () => {
    const r = await partition(`${SERVER_IDLE_MS} millis`, 10_000);
    console.log(`DIAG leader partition: the leader knew after ${r.leaderLostMs} ms, the follower led after ${r.followerLeadsMs} ms (serverIdleTimeout ${SERVER_IDLE_MS} ms)`);
    assert.ok(r.leaderLostMs !== null && r.leaderLostMs <= 1_400 + 500, `the leader knew within its bound (${r.leaderLostMs} ms)`);
    assert.ok(r.followerLeadsMs !== null, "a follower took the lock");
    assert.ok(r.followerLeadsMs >= SERVER_IDLE_MS - 300 && r.followerLeadsMs <= SERVER_IDLE_MS + 1_500, `the lock was freed by the server's timeout (${r.followerLeadsMs} ms)`);
    assert.ok(r.leaderLostMs < r.followerLeadsMs, "the old leader stopped before the follower led");
  });

  it("without it (off), the lock stays with the silent session: no follower leads", { timeout: 30_000 }, async () => {
    const r = await partition("off", SERVER_IDLE_MS + 3_000);
    console.log(`DIAG leader partition (off): the leader knew after ${r.leaderLostMs} ms`);
    assert.ok(r.leaderLostMs !== null, "the leader still knows it lost");
    assert.strictEqual(r.followerLeadsMs, null, "no follower could lead: Postgres keeps the lock until its keepalives give up");
    assert.ok(r.lockStillHeld);
  });

  it("a leader that keeps its heartbeat keeps its lock, however long, with a short timeout", { timeout: 30_000 }, async () => {
    const key = newKey();
    const leader = (await acquire(direct, key, { ...fast, serverIdleTimeout: "2 seconds" }))!;
    try {
      await sleep(8_000); // four timeouts' worth
      assert.ok(leader.isLeader() && (await lockHeld(key)), "still leading, and the lock is still held");
    } finally {
      await direct.runPromise(leader.release());
    }
  });

  it("a connection given back to the pool does not carry the lease", { timeout: 30_000 }, async () => {
    const one = runtimeTo(db.connInfo.host, db.connInfo.port, 1); // one connection: the next query gets the one the leader used
    try {
      const leader = (await acquire(one, newKey(), fast))!;
      await one.runPromise(leader.release());
      const [after] = await one.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<{ idle_session_timeout: string }>("SHOW idle_session_timeout")));
      assert.strictEqual(after!.idle_session_timeout, "0");
    } finally {
      await one.dispose();
    }
  });
});
