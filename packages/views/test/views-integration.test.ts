// Runs under Node (Testcontainers) - see NOTES.md.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive, type StoredEvent } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { makeViewsProcessor } from "../src/ViewsModule.ts";
import { viewSubscriptionOf } from "../src/ViewSubscription.ts";
import { makeTransactionalViewProjector, type ViewProjector } from "../src/ViewProjector.ts";
import type { ViewsConfig } from "../src/ViewsConfig.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | SqlClient.SqlClient | PgClient.PgClient, never>;

// ManagedRuntime, not plain Layer + Effect.provide, since makeViewsProcessor()'s handle.service.start
// forks long-lived daemon fibers that must keep using the same connection pool across many separate
// run() calls in one test - see event-processor-integration.test.ts's primer on this.
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

  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("CREATE TABLE IF NOT EXISTS views_test_scratch (id text primary key)");
    })
  );
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

const getProgress = (viewName: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ last_position: string; status: string; error_count: number }>(
        "SELECT last_position, status, error_count FROM crablet_view_progress WHERE view_name = $1",
        [viewName]
      );
      return rows[0] ?? null;
    })
  );

const baseViewsConfig: ViewsConfig = {
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

const fakeProjector = (
  viewName: string,
  onHandle: (events: ReadonlyArray<StoredEvent>) => void
): ViewProjector => ({
  viewName,
  handle: (events) =>
    Effect.sync(() => {
      onHandle(events);
      return events.length;
    })
});

describe("views module integration (real Postgres)", () => {
  it("two views with different selections each only see their own events", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const viewNameA = `views-integ-a-${runId}`;
    const viewNameB = `views-integ-b-${runId}`;
    const typeA = `ViewsIntegEventA-${runId}`;
    const typeB = `ViewsIntegEventB-${runId}`;

    const seenA: Array<StoredEvent> = [];
    const seenB: Array<StoredEvent> = [];

    const handle = await run(
      makeViewsProcessor({
        config: baseViewsConfig,
        projectors: [fakeProjector(viewNameA, (events) => seenA.push(...events)), fakeProjector(viewNameB, (events) => seenB.push(...events))],
        subscriptions: [
          viewSubscriptionOf(viewNameA, { eventTypes: new Set([typeA]) }),
          viewSubscriptionOf(viewNameB, { eventTypes: new Set([typeB]) })
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

      await waitUntilAsync(() => getProgress(viewNameA), (p) => p !== null && p.last_position !== "0");
      await waitUntilAsync(() => getProgress(viewNameB), (p) => p !== null && p.last_position !== "0");

      assert.strictEqual(seenA.length, 1);
      assert.strictEqual(seenA[0]!.type, typeA);
      assert.strictEqual(seenB.length, 1);
      assert.strictEqual(seenB[0]!.type, typeB);
    } finally {
      await run(handle.service.stop);
    }
  });

  it("a transactional projector rolls back the whole batch when one event's handler throws", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const viewName = `views-integ-tx-${runId}`;
    const eventType = `ViewsIntegTxEvent-${runId}`;
    const okId = `ok-${runId}`;
    const failId = `fail-${runId}`;

    // Append both events BEFORE starting the processor so they land in the same fetch batch -
    // the whole point of this test is that the ok event's insert, sharing a transaction with the
    // fail event's insert, gets rolled back too.
    await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.appendCommutative([AppendEvent.of(eventType, "marker", okId, {})]);
        yield* store.appendCommutative([AppendEvent.of(eventType, "marker", failId, {})]);
      })
    );

    const projector = await run(
      makeTransactionalViewProjector(viewName, (event, sql) =>
        Effect.gen(function* () {
          const marker = event.tags.find((t) => t.key === "marker")?.value;
          if (marker === failId) {
            // A typed failure (not Effect.die) - only typed failures flow through
            // EventProcessor.ts's Effect.tapError into progressTracker.recordError, which is what
            // drives error_count/FAILED status. Still rolls back the transaction either way.
            return yield* Effect.fail("simulated handler failure");
          }
          yield* sql.unsafe("INSERT INTO views_test_scratch (id) VALUES ($1)", [marker]);
        })
      )
    );

    const handle = await run(
      makeViewsProcessor({
        config: baseViewsConfig,
        projectors: [projector],
        subscriptions: [viewSubscriptionOf(viewName, { eventTypes: new Set([eventType]) })],
        instanceId: `instance-${crypto.randomUUID()}`
      })
    );

    try {
      await run(handle.service.start);

      await waitUntilAsync(() => getProgress(viewName), (p) => p !== null && p.error_count > 0);

      const scratchRows = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql.unsafe<{ id: string }>(
            "SELECT id FROM views_test_scratch WHERE id = $1 OR id = $2",
            [okId, failId]
          );
        })
      );

      assert.strictEqual(scratchRows.length, 0, "expected the ok event's insert to roll back with the batch");
    } finally {
      await run(handle.service.stop);
    }
  });

  it("real LISTEN/NOTIFY triggers an immediate poll well before the configured interval elapses", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const viewName = `views-integ-wakeup-${runId}`;
    const eventType = `ViewsIntegWakeupEvent-${runId}`;

    const seen: Array<StoredEvent> = [];
    const handle = await run(
      makeViewsProcessor({
        config: { ...baseViewsConfig, pollingIntervalMs: 60_000 },
        projectors: [fakeProjector(viewName, (events) => seen.push(...events))],
        subscriptions: [viewSubscriptionOf(viewName, { eventTypes: new Set([eventType]) })],
        instanceId: `instance-${crypto.randomUUID()}`
      })
    );

    try {
      await run(handle.service.start);
      await waitUntilAsync(() => getProgress(viewName), (p) => p !== null);
      // PgClient.listen uses a dedicated connection - give it the same small registration grace
      // period listen-notify.test.ts uses before sending a NOTIFY that Postgres will not replay.
      await new Promise((resolve) => setTimeout(resolve, 200));

      await run(
        Effect.gen(function* () {
          const store = yield* EventStore;
          // appendCommutative fires NOTIFY on EVENTS_CHANNEL automatically (Phase 3 NOTIFY-wiring
          // fix) - no manual notify() call needed.
          yield* store.appendCommutative([AppendEvent.ofUntagged(eventType, {})]);
        })
      );

      const finalProgress = await waitUntilAsync(
        () => getProgress(viewName),
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
