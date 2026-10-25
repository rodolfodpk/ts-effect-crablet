// Runs under Node (Testcontainers). One lock session per process (ADR-0046): the leaders of every module in a process hold their locks on ONE
// connection, checked by one heartbeat; it is reserved with the first lock and given back with the last.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { AUTOMATIONS_LOCK_KEY, DEADLINES_LOCK_KEY, OUTBOX_LOCK_KEY, tryAcquireGlobalLeader, VIEWS_LOCK_KEY, type LeaderHandle } from "../../src/Leader.ts";

type Rt = ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, never>;
let db: TestDb;
let processA: Rt;
let processB: Rt;
let probe: Rt;
const runtime = (name: string): Rt =>
  ManagedRuntime.make(PgClient.layer({
    host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), applicationName: name
  }) as unknown as Layer.Layer<SqlClient.SqlClient, never>);

before(async () => {
  db = await startTestDb();
  processA = runtime("process-a");
  processB = runtime("process-b");
  probe = runtime("probe");
}, { timeout: 60_000 });
after(async () => {
  await processA.dispose();
  await processB.dispose();
  await probe.dispose();
  await db.stop();
});

const KEYS = [VIEWS_LOCK_KEY, AUTOMATIONS_LOCK_KEY, OUTBOX_LOCK_KEY, DEADLINES_LOCK_KEY];
const fast = { heartbeat: "100 millis", verifyTimeout: "500 millis", failuresBeforeLost: 2 } as const;
const acquire = (rt: Rt, key: bigint) => rt.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => tryAcquireGlobalLeader(sql, key, fast)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const holders = () =>
  probe.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.unsafe<{ key: string; pid: number; app: string }>(
      `SELECT ((l.classid::bigint << 32) | l.objid::bigint)::text AS key, l.pid, a.application_name AS app
         FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE l.locktype = 'advisory' AND l.granted ORDER BY 1`
    )
  ));
const sessionsOf = (app: string) =>
  probe.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.unsafe<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1", [app])
  )).then((r) => r[0]!.n);

describe("one lock session per process (ADR-0046)", () => {
  it("four modules leading in one process hold their four locks on one session; another process gets none of them", { timeout: 30_000 }, async () => {
    const leaders = (await Promise.all(KEYS.map((k) => acquire(processA, k)))) as Array<LeaderHandle>;
    try {
      assert.ok(leaders.every((l) => l !== null && l.isLeader()));
      const held = await holders();
      assert.deepStrictEqual(held.map((h) => h.key), KEYS.map(String).sort());
      assert.strictEqual(new Set(held.map((h) => h.pid)).size, 1, "one session holds all four");
      assert.strictEqual(await sessionsOf("process-a"), 1, "and the process has one connection for them");

      for (const k of KEYS) assert.strictEqual(await acquire(processB, k), null, "another process does not get a lock held here");
      assert.strictEqual(await acquire(processA, VIEWS_LOCK_KEY), null, "nor does a second leader of the same module in this process (locks are re-entrant)");
      await sleep(500); // five heartbeats
      assert.ok(leaders.every((l) => l.isLeader()));
    } finally {
      for (const l of leaders) await processA.runPromise(l.release());
    }
    assert.deepStrictEqual(await holders(), [], "every lock released");
  });

  it("releasing one module's lock keeps the others; the connection goes back with the last", { timeout: 30_000 }, async () => {
    const views = (await acquire(processA, VIEWS_LOCK_KEY))!;
    const outbox = (await acquire(processA, OUTBOX_LOCK_KEY))!;
    await processA.runPromise(views.release());
    assert.ok(outbox.isLeader() && (await processA.runPromise(outbox.verify)));
    assert.deepStrictEqual((await holders()).map((h) => h.key), [String(OUTBOX_LOCK_KEY)]);
    const taken = await acquire(processB, VIEWS_LOCK_KEY);
    assert.ok(taken !== null, "another process takes the released lock");
    await processB.runPromise(taken.release());
    await processA.runPromise(outbox.release());
    assert.deepStrictEqual(await holders(), []);
  });

  it("when the session dies every leader on it is lost together, and the next attempt leads on a new session", { timeout: 30_000 }, async () => {
    const leaders = (await Promise.all(KEYS.map((k) => acquire(processA, k)))) as Array<LeaderHandle>;
    const [{ pid }] = await holders();
    await probe.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.asVoid(sql.unsafe("SELECT pg_terminate_backend($1)", [pid]))));
    for (let i = 0; i < 50 && leaders.some((l) => l.isLeader()); i++) await sleep(100);
    assert.ok(leaders.every((l) => !l.isLeader()), "all four lost");
    const again = (await acquire(processA, VIEWS_LOCK_KEY))!;
    assert.ok(again !== null && again.isLeader());
    const [now] = await holders();
    assert.notStrictEqual(now!.pid, pid, "on a new session");
    await processA.runPromise(again.release());
  });
});
