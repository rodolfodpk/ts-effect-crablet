// Runs under Node (Testcontainers) - see NOTES.md.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive, type StoredEvent } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { makeOutboxProcessor } from "../src/OutboxModule.ts";
import { topicConfigOf } from "../src/TopicConfig.ts";
import type { OutboxConfig } from "../src/OutboxConfig.ts";
import type { OutboxPublisher } from "../src/OutboxPublisher.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | SqlClient.SqlClient | PgClient.PgClient, never>;

// ManagedRuntime, not plain Layer + Effect.provide - see views-integration.test.ts's primer on why
// makeOutboxProcessor()'s handle.service.start (forks long-lived daemon fibers) needs this.
before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  const layer = Layer.provideMerge(EventStoreLive, pgLayer) as unknown as Layer.Layer<
    EventStore | SqlClient.SqlClient | PgClient.PgClient,
    never
  >;
  runtime = ManagedRuntime.make(layer);
}, { timeout: 60_000 });

after(async () => {
  await runtime.dispose();
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, EventStore | SqlClient.SqlClient | PgClient.PgClient>) =>
  runtime.runPromise(effect);

const waitUntilAsync = async <A>(check: () => Promise<A>, predicate: (a: A) => boolean, timeoutMs = 10_000) => {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const getProgress = (topic: string, publisher: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ last_position: string; status: string; error_count: number }>(
        "SELECT last_position, status, error_count FROM crablet_outbox_topic_progress WHERE topic = $1 AND publisher = $2",
        [topic, publisher]
      );
      return rows[0] ?? null;
    })
  );

const baseOutboxConfig: OutboxConfig = {
  enabled: true,
  pollingIntervalMs: 100,
  batchSize: 100,
  backoffEnabled: false,
  backoffThreshold: 3,
  backoffMultiplier: 2,
  backoffMaxSeconds: 120,
  leaderElectionRetryIntervalMs: 30_000,
  maxErrors: 5
};

const fakePublisher = (
  name: string,
  onPublish: (events: ReadonlyArray<StoredEvent>) => void
): OutboxPublisher => ({
  name,
  publishBatch: (events) => Effect.sync(() => onPublish(events))
});

describe("outbox module integration (real Postgres)", () => {
  it("two publishers on different topics each only see their own topic's events", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const topicA = `outbox-integ-a-${runId}`;
    const topicB = `outbox-integ-b-${runId}`;
    const typeA = `OutboxIntegEventA-${runId}`;
    const typeB = `OutboxIntegEventB-${runId}`;

    const seenA: Array<StoredEvent> = [];
    const seenB: Array<StoredEvent> = [];

    const handle = await run(
      makeOutboxProcessor({
        config: baseOutboxConfig,
        topics: [
          topicConfigOf(topicA, { eventTypes: new Set([typeA]), publishers: ["pubA"] }),
          topicConfigOf(topicB, { eventTypes: new Set([typeB]), publishers: ["pubB"] })
        ],
        publishers: [
          fakePublisher("pubA", (events) => seenA.push(...events)),
          fakePublisher("pubB", (events) => seenB.push(...events))
        ],
        instanceId: `instance-${crypto.randomUUID()}`
      })
    );

    try {
      await run(handle.service.start);

      await run(
        Effect.gen(function* () {
          const store = yield* EventStore;
          yield* store.appendCommutative([AppendEvent.ofUntagged(typeA, {})]);
          yield* store.appendCommutative([AppendEvent.ofUntagged(typeB, {})]);
        })
      );

      await waitUntilAsync(() => getProgress(topicA, "pubA"), (p) => p !== null && p.last_position !== "0");
      await waitUntilAsync(() => getProgress(topicB, "pubB"), (p) => p !== null && p.last_position !== "0");

      assert.strictEqual(seenA.length, 1);
      assert.strictEqual(seenA[0]!.type, typeA);
      assert.strictEqual(seenB.length, 1);
      assert.strictEqual(seenB[0]!.type, typeB);
    } finally {
      await run(handle.service.stop);
    }
  });

  it("two publishers on the SAME topic advance independently - one failing doesn't block the other", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const topic = `outbox-integ-same-topic-${runId}`;
    const eventType = `OutboxIntegSameTopicEvent-${runId}`;

    const seenGood: Array<StoredEvent> = [];

    const handle = await run(
      makeOutboxProcessor({
        config: baseOutboxConfig,
        topics: [topicConfigOf(topic, { eventTypes: new Set([eventType]), publishers: ["good", "bad"] })],
        publishers: [
          fakePublisher("good", (events) => seenGood.push(...events)),
          { name: "bad", publishBatch: () => Effect.fail("simulated publish failure") }
        ],
        instanceId: `instance-${crypto.randomUUID()}`
      })
    );

    try {
      await run(handle.service.start);

      await run(
        Effect.gen(function* () {
          const store = yield* EventStore;
          yield* store.appendCommutative([AppendEvent.ofUntagged(eventType, {})]);
        })
      );

      const goodProgress = await waitUntilAsync(
        () => getProgress(topic, "good"),
        (p) => p !== null && p.last_position !== "0"
      );
      const badProgress = await waitUntilAsync(
        () => getProgress(topic, "bad"),
        (p) => p !== null && p.error_count > 0
      );

      assert.ok(goodProgress !== null && goodProgress.last_position !== "0", "good publisher should have advanced");
      assert.strictEqual(seenGood.length, 1);
      assert.ok(
        badProgress !== null && badProgress.error_count > 0 && badProgress.last_position === "0",
        "bad publisher should have recorded an error and never advanced past position 0"
      );
    } finally {
      await run(handle.service.stop);
    }
  });

  it("real LISTEN/NOTIFY triggers an immediate poll well before the configured interval elapses", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const topic = `outbox-integ-wakeup-${runId}`;
    const eventType = `OutboxIntegWakeupEvent-${runId}`;

    const seen: Array<StoredEvent> = [];
    const handle = await run(
      makeOutboxProcessor({
        config: { ...baseOutboxConfig, pollingIntervalMs: 60_000 },
        topics: [topicConfigOf(topic, { eventTypes: new Set([eventType]), publishers: ["pub"] })],
        publishers: [fakePublisher("pub", (events) => seen.push(...events))],
        instanceId: `instance-${crypto.randomUUID()}`
      })
    );

    try {
      await run(handle.service.start);
      await waitUntilAsync(() => getProgress(topic, "pub"), (p) => p !== null);
      // PgClient.listen uses a dedicated connection - give it the same small registration grace
      // period listen-notify.test.ts uses before sending a NOTIFY that Postgres will not replay.
      await new Promise((resolve) => setTimeout(resolve, 200));

      await run(
        Effect.gen(function* () {
          const store = yield* EventStore;
          // appendCommutative fires NOTIFY on EVENTS_CHANNEL automatically (Phase 3 fix) - no
          // manual notify() call needed.
          yield* store.appendCommutative([AppendEvent.ofUntagged(eventType, {})]);
        })
      );

      const finalProgress = await waitUntilAsync(
        () => getProgress(topic, "pub"),
        (p) => p !== null && p.last_position !== "0",
        5_000
      );
      assert.ok(
        finalProgress !== null && finalProgress.last_position !== "0",
        "expected the wakeup to trigger a poll within 5s, well under the 60s interval"
      );
      assert.strictEqual(seen.length, 1);
    } finally {
      await run(handle.service.stop);
    }
  });
});
