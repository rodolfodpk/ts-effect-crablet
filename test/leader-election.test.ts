// Runs under Node (Testcontainers) - see NOTES.md.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "../src/testcontainer.ts";
import { tryAcquireGlobalLeader } from "../src/leader.ts";

let db: TestDb;
let layer: Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, never>;

before(async () => {
  db = await startTestDb();
  layer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  }) as unknown as Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, never>;
}, { timeout: 60_000 });

after(async () => {
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

describe("advisory-lock leader election parity (Phase 0, Risk B part 2)", () => {
  it("two concurrent acquisitions on the same key: exactly one succeeds (20 runs)", async () => {
    for (let i = 0; i < 20; i++) {
      const lockKey = BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);

      const attempt = () =>
        run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const handle = yield* tryAcquireGlobalLeader(sql, lockKey);
            return handle !== null;
          })
        );

      const [a, b] = await Promise.all([attempt(), attempt()]);
      const successCount = [a, b].filter(Boolean).length;
      assert.strictEqual(successCount, 1, `iteration ${i}: expected exactly one acquisition, got [${a}, ${b}]`);
    }
  }, { timeout: 30_000 });

  it("loser can acquire after winner releases", async () => {
    const lockKey = BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);

    const winner = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* tryAcquireGlobalLeader(sql, lockKey);
      })
    );
    assert.ok(winner !== null);

    const secondAttemptWhileHeld = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* tryAcquireGlobalLeader(sql, lockKey);
      })
    );
    assert.strictEqual(secondAttemptWhileHeld, null);

    await Effect.runPromise(winner!.release());

    const afterRelease = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* tryAcquireGlobalLeader(sql, lockKey);
      })
    );
    assert.ok(afterRelease !== null);
    await Effect.runPromise(afterRelease!.release());
  });

  // NB: this exercises the graceful release path, not a true crash (connection dropped without
  // running pg_advisory_unlock). leader.ts doesn't currently expose raw access to force that
  // simulation, and reusing LeaderHandle.release() here is a known simplification - see NOTES.md.
  // The Java-side equivalent (LeaderElectorImplTest, if extended) can cover the true crash path
  // via direct connection.close(); this TS test only confirms reacquisition works after release.
  it("lock is acquirable again immediately after release", async () => {
    const lockKey = BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);

    const holder = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* tryAcquireGlobalLeader(sql, lockKey);
      })
    );
    assert.ok(holder !== null);
    await Effect.runPromise(holder!.release());

    const reacquired = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* tryAcquireGlobalLeader(sql, lockKey);
      })
    );
    assert.ok(reacquired !== null);
    await Effect.runPromise(reacquired!.release());
  });
});
