// Runs under Node (Testcontainers) - see NOTES.md. A leader must KNOW when it has lost the lock (docs/plans/reliability-and-scale-diagnostic.md, F1, step 1):
// a session-level advisory lock lives exactly as long as its session, so when the leader's database session dies the lock is gone and another instance
// can take it. `isLeader()` used to stay true for ever; now a heartbeat on the leader's own connection notices, and `verify` answers on demand.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { tryAcquireGlobalLeader, type LeaderHandle } from "../../src/Leader.ts";

let db: TestDb;
// One runtime (one pool) for the whole file: a pool built and closed around each call would wait on the connection a leader still holds (@effect/sql-pg 4.0.2).
let rt: ManagedRuntime.ManagedRuntime<PgClient.PgClient | SqlClient.SqlClient, never>;

before(async () => {
  db = await startTestDb();
  rt = ManagedRuntime.make(PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  }) as unknown as Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, never>);
}, { timeout: 60_000 });
after(async () => {
  await rt.dispose();
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => rt.runPromise(effect);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newKey = () => BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);
const fast = { heartbeat: "100 millis", verifyTimeout: "1 second", failuresBeforeLost: 2 } as const;

const acquire = (key: bigint, options: Parameters<typeof tryAcquireGlobalLeader>[2] = fast) =>
  run(Effect.flatMap(SqlClient.SqlClient, (sql) => tryAcquireGlobalLeader(sql, key, options)));
const holderPid = (key: bigint) =>
  run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.map(
        sql.unsafe<{ pid: number }>("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND ((classid::bigint << 32) | objid::bigint) = $1::bigint", [key.toString()]),
        (rows) => rows[0]?.pid ?? null
      )
    )
  );
const kill = (pid: number) => run(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.asVoid(sql.unsafe("SELECT pg_terminate_backend($1)", [pid]))));
const waitUntil = async (check: () => boolean, ms: number) => {
  const start = Date.now();
  while (!check() && Date.now() - start < ms) await sleep(20);
  return check();
};

describe("a leader knows whether it still holds the lock", () => {
  it("a healthy leader stays leader across many heartbeats, and verify says so", { timeout: 20_000 }, async () => {
    const leader = (await acquire(newKey()))!;
    try {
      await sleep(800); // eight heartbeats
      assert.strictEqual(leader.isLeader(), true);
      assert.strictEqual(await Effect.runPromise(leader.verify), true);
    } finally {
      await Effect.runPromise(leader.release());
    }
  });

  it("when its database session is terminated, isLeader() turns false within a second (it used to stay true for ever)", { timeout: 20_000 }, async () => {
    const key = newKey();
    const leader = (await acquire(key))!;
    const pid = await holderPid(key);
    assert.ok(pid !== null, "the leader holds the advisory lock");
    const killedAt = Date.now();
    await kill(pid);
    const noticed = await waitUntil(() => !leader.isLeader(), 3_000);
    assert.ok(noticed, "the leader noticed within 3 s");
    assert.ok(Date.now() - killedAt < 1_500, `and quickly (${Date.now() - killedAt} ms with a 100 ms heartbeat)`);
    await Effect.runPromise(leader.release());
  });

  it("verify answers false at once on a dead session, without waiting for the heartbeat", { timeout: 20_000 }, async () => {
    const key = newKey();
    const leader = (await acquire(key, { heartbeat: "1 hour", verifyTimeout: "1 second", failuresBeforeLost: 2 }))!; // the heartbeat will not run in this test
    const pid = await holderPid(key);
    await kill(pid!);
    await sleep(200);
    assert.strictEqual(await Effect.runPromise(leader.verify), false, "fail closed on the first failed check");
    assert.strictEqual(leader.isLeader(), true, "one failed check is not yet 'lost' (the threshold is two)");
    assert.strictEqual(await Effect.runPromise(leader.verify), false);
    assert.strictEqual(leader.isLeader(), false, "the second consecutive failure makes it lost");
    await Effect.runPromise(leader.release());
  });

  it("after the loss another instance can take the lock, and release() on the lost handle is prompt and repeatable", { timeout: 20_000 }, async () => {
    const key = newKey();
    const leader = (await acquire(key))!;
    await kill((await holderPid(key))!);
    assert.ok(await waitUntil(() => !leader.isLeader(), 3_000));

    const successor = await acquire(key);
    assert.ok(successor !== null, "the lock was free: the old session is gone");
    assert.strictEqual(successor!.isLeader(), true);

    const started = Date.now();
    await Effect.runPromise(leader.release());
    await Effect.runPromise(leader.release()); // twice: harmless
    assert.ok(Date.now() - started < 2_000, "releasing a dead handle does not hang");
    assert.strictEqual(successor!.isLeader(), true, "and it does not disturb the new leader");
    await Effect.runPromise(successor!.release());
  });

  it("release() ends leadership at once and stops the heartbeat; a second instance can then take over", { timeout: 20_000 }, async () => {
    const key = newKey();
    const leader: LeaderHandle = (await acquire(key))!;
    await Effect.runPromise(leader.release());
    assert.strictEqual(leader.isLeader(), false);
    assert.strictEqual(await Effect.runPromise(leader.verify), false, "a released handle does not claim leadership");
    const next = await acquire(key);
    assert.ok(next !== null);
    await Effect.runPromise(next!.release());
  });

  it("a graceful release announces itself on crablet_events, so followers need not wait for their retry timer; a lost leader sends nothing", { timeout: 20_000 }, async () => {
    const listener = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
    await listener.connect();
    await listener.query("LISTEN crablet_events");
    const payloads: Array<string | undefined> = [];
    listener.on("notification", (n) => payloads.push(n.payload));
    try {
      const graceful = (await acquire(newKey()))!;
      await Effect.runPromise(graceful.release());
      assert.ok(await waitUntil(() => payloads.length === 1, 2000), "one notification after a graceful release");
      assert.ok(payloads[0] === "*" || payloads[0] === "" || payloads[0] === undefined, "a wildcard payload");

      const key = newKey();
      const doomed = (await acquire(key))!;
      await kill((await holderPid(key))!);
      assert.ok(await waitUntil(() => !doomed.isLeader(), 3000));
      await Effect.runPromise(doomed.release());
      await sleep(300);
      assert.strictEqual(payloads.length, 1, "a leader whose session died cannot announce anything");
    } finally {
      await listener.end();
    }
  });
});
