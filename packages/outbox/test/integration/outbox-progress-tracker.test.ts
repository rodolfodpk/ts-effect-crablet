// Runs under Node (Testcontainers) - see NOTES.md. The outbox keeps its progress per (topic, publisher), so it has its own tracker; this is what pauses a topic and what
// reports that the progress table has not been migrated yet.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Exit, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { ProgressTableNotReady } from "@crablet/event-poller/ProgressTracker";
import * as ProgressCursorNS from "@crablet/event-poller/ProgressCursor";
import { makeOutboxProgressTracker } from "../../src/internal/OutboxProgressTracker.ts";
import { fromKey, toKey } from "../../src/TopicPublisherPair.ts";

let db: TestDb;
let layer: Layer.Layer<SqlClient.SqlClient, never>;

before(async () => {
  db = await startTestDb();
  layer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  }) as unknown as Layer.Layer<SqlClient.SqlClient, never>;
}, { timeout: 60_000 });

after(async () => {
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);
const key = () => toKey({ topic: `topic-${crypto.randomUUID()}`, publisher: "log" });

describe("the outbox progress tracker (against crablet_outbox_topic_progress)", () => {
  it("a topic can be paused and resumed, and only that topic and publisher change", async () => {
    const a = key();
    const b = key();
    const statuses = await run(
      Effect.gen(function* () {
        const tracker = yield* makeOutboxProgressTracker("instance-a");
        yield* tracker.autoRegister(a, "instance-a");
        yield* tracker.autoRegister(b, "instance-a");
        yield* tracker.setStatus(a, "PAUSED");
        const paused = [yield* tracker.getStatus(a), yield* tracker.getStatus(b)];
        yield* tracker.setStatus(a, "ACTIVE");
        return { paused, resumed: yield* tracker.getStatus(a) };
      })
    );
    assert.deepStrictEqual(statuses.paused, ["PAUSED", "ACTIVE"]);
    assert.strictEqual(statuses.resumed, "ACTIVE");
  });

  it("the error count resets after a good batch, and enough errors mark the topic FAILED", async () => {
    const k = key();
    const result = await run(
      Effect.gen(function* () {
        const tracker = yield* makeOutboxProgressTracker("instance-a");
        yield* tracker.autoRegister(k, "instance-a");
        yield* tracker.recordError(k, "broker down", 3);
        yield* tracker.recordError(k, "broker down", 3);
        yield* tracker.resetErrorCount(k);
        yield* tracker.recordError(k, "broker down", 3);
        const afterReset = yield* tracker.getStatus(k);
        yield* tracker.recordError(k, "broker down", 3);
        yield* tracker.recordError(k, "broker down", 3);
        return { afterReset, failed: yield* tracker.getStatus(k) };
      })
    );
    assert.strictEqual(result.afterReset, "ACTIVE", "the reset made the earlier errors not count");
    assert.strictEqual(result.failed, "FAILED");
  });

  it("the cursor only moves forward", async () => {
    const k = key();
    const cursor = await run(
      Effect.gen(function* () {
        const tracker = yield* makeOutboxProgressTracker("instance-a");
        yield* tracker.autoRegister(k, "instance-a");
        yield* tracker.updateCursor(k, ProgressCursorNS.of("10", 50n));
        yield* tracker.updateCursor(k, ProgressCursorNS.of("5", 20n)); // a late write from a leader that lost the lock
        return yield* tracker.getCursor(k);
      })
    );
    assert.deepStrictEqual(cursor, ProgressCursorNS.of("10", 50n));
  });

  it("peekCursor reads the cursor without refreshing the leader columns that getCursor refreshes, and says so when the topic has no row yet", async () => {
    const k = key();
    const { peeked, afterPeek, afterGet, unknown } = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tracker = yield* makeOutboxProgressTracker("instance-sampler");
        yield* tracker.autoRegister(k, "instance-a");
        yield* tracker.updateCursor(k, ProgressCursorNS.of("10", 50n));
        const leaderOf = () => sql.unsafe<{ leader_instance: string | null }>("SELECT leader_instance FROM crablet_outbox_topic_progress WHERE topic = $1", [fromKey(k).topic]);
        yield* sql.unsafe("UPDATE crablet_outbox_topic_progress SET leader_instance = 'instance-a', leader_heartbeat = NULL WHERE topic = $1", [fromKey(k).topic]);
        const peeked = yield* tracker.peekCursor(k);
        const afterPeek = (yield* leaderOf())[0]!.leader_instance;
        yield* tracker.getCursor(k);
        const afterGet = (yield* leaderOf())[0]!.leader_instance;
        return { peeked, afterPeek, afterGet, unknown: yield* tracker.peekCursor(key()) };
      })
    );
    assert.deepStrictEqual(peeked, ProgressCursorNS.of("10", 50n));
    assert.strictEqual(afterPeek, "instance-a", "the peek attributed nothing to the sampler");
    assert.strictEqual(afterGet, "instance-sampler", "getCursor does refresh it, which is why monitoring must not use it");
    assert.deepStrictEqual(unknown, ProgressCursorNS.zero);
  });

  it("before the progress table exists the cursor read says so with ProgressTableNotReady, not with a raw SQL error", async () => {
    await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("DROP TABLE crablet_outbox_topic_progress")));
    const exit = await run(
      Effect.exit(
        Effect.gen(function* () {
          const tracker = yield* makeOutboxProgressTracker("instance-a");
          return yield* tracker.getCursor(key());
        })
      )
    );
    assert.ok(Exit.isFailure(exit));
    const failure = exit.cause.reasons.find((r) => "error" in r);
    assert.ok(failure !== undefined && "error" in failure && failure.error instanceof ProgressTableNotReady);
  });
});
