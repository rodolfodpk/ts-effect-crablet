// Runs under Node (Testcontainers). The race CI hit once on leader-shared-session.test.ts (ADR-0046): the shared lock session dies, its leaders are lost,
// and an attempt runs before their releases have given the dead session back. Without the guard it ran its try-lock on the dead connection and failed
// with the server's "terminating connection due to administrator command"; with it, the attempt takes a new session. Repeated, because the window is
// a few milliseconds wide; an attempt is started the moment the leaders are seen lost, to land inside it.
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
let probe: Rt;
const runtime = (name: string): Rt =>
  ManagedRuntime.make(PgClient.layer({
    host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), applicationName: name
  }) as unknown as Layer.Layer<SqlClient.SqlClient, never>);

before(async () => {
  db = await startTestDb();
  processA = runtime("race-a");
  probe = runtime("race-probe");
}, { timeout: 60_000 });
after(async () => {
  await processA.dispose();
  await probe.dispose();
  await db.stop();
});

const KEYS = [VIEWS_LOCK_KEY, AUTOMATIONS_LOCK_KEY, OUTBOX_LOCK_KEY, DEADLINES_LOCK_KEY];
const fast = { heartbeat: "20 millis", verifyTimeout: "500 millis", failuresBeforeLost: 1 } as const;
const acquire = (key: bigint) => processA.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => tryAcquireGlobalLeader(sql, key, fast)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const holderPid = () =>
  probe.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.unsafe<{ pid: number }>("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted LIMIT 1")
  )).then((r) => r[0]?.pid);

describe("an attempt right after the shared lock session dies (ADR-0046)", () => {
  it("takes a new session instead of the dead one, every time", { timeout: 120_000 }, async () => {
    const ROUNDS = 40;
    for (let round = 0; round < ROUNDS; round++) {
      const leaders = (await Promise.all(KEYS.map(acquire))) as Array<LeaderHandle>;
      assert.ok(leaders.every((l) => l !== null), `round ${round}: all four lead`);
      const pid = (await holderPid())!;
      await probe.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.asVoid(sql.unsafe("SELECT pg_terminate_backend($1)", [pid]))));
      // Attempt the moment any leader is seen lost, while the releases are still giving the session back.
      while (leaders.every((l) => l.isLeader())) await sleep(1);
      const again = await acquire(VIEWS_LOCK_KEY).catch((e: unknown) => assert.fail(`round ${round}: the attempt failed: ${String(e)}`));
      if (again !== null) await processA.runPromise(again.release());
      for (let i = 0; i < 100 && leaders.some((l) => l.isLeader()); i++) await sleep(10);
      for (const l of leaders) await processA.runPromise(l.release());
    }
  });
});

describe("an attempt on the shared lock session after it died, before the heartbeat noticed (ADR-0046)", () => {
  it("loses every leader on the session at once, and leads at once on a new session instead of waiting for the module's retry", { timeout: 30_000 }, async () => {
    const slow = { heartbeat: "10 seconds", verifyTimeout: "500 millis", failuresBeforeLost: 1 } as const;
    const acquireSlow = (key: bigint) => processA.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => tryAcquireGlobalLeader(sql, key, slow)));
    const leaders = (await Promise.all(KEYS.slice(0, 3).map(acquireSlow))) as Array<LeaderHandle>;
    const pid = (await holderPid())!;
    await probe.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.asVoid(sql.unsafe("SELECT pg_terminate_backend($1)", [pid]))));
    await sleep(200);
    assert.ok(leaders.every((l) => l.isLeader()), "the heartbeat has not noticed yet");

    // The attempt runs on the dead session first: its failure loses every leader on it, and the attempt is made again on a new one.
    const again = await acquireSlow(DEADLINES_LOCK_KEY);
    assert.ok(leaders.every((l) => !l.isLeader()), "every leader on the dead session is lost, without waiting for the heartbeat");
    assert.ok(again !== null && again.isLeader(), "the attempt leads");
    assert.notStrictEqual(await holderPid(), pid, "on a new session");
    await processA.runPromise(again.release());
    for (const l of leaders) await processA.runPromise(l.release());
  });
});
