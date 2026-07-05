// Runs under Node (Testcontainers) - see NOTES.md.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { tryAcquireGlobalLeader } from "@crablet/eventstore/Leader";
import { notify, wakeupStream } from "@crablet/eventstore/Listen";
import { encodePayload } from "@crablet/eventstore/NotifyPayload";
import { makeEventProcessor } from "../src/EventProcessor.ts";
import { makePostgresProgressTracker } from "../src/PostgresProgressTracker.ts";
import { makeSqlEventFetcher } from "../src/SqlEventFetcher.ts";
import { processorConfigOf } from "../src/ProcessorConfig.ts";
import * as EventSelection from "../src/EventSelection.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | SqlClient.SqlClient | PgClient.PgClient, never>;

const WAKEUP_CHANNEL = "crablet_events_event_poller_integ";

// PATTERN PRIMER - `ManagedRuntime`, vs. `Layer.Layer` + `Effect.provide` used everywhere else in
// this codebase. A plain `Layer.Layer` is rebuilt (a fresh connection pool!) on every single
// `Effect.provide`/`Effect.runPromise` call - fine for one-shot effects (every other test file in
// this repo does exactly that), but fatal here: `EventProcessor.start()` forks long-lived
// background fibers (leader-retry, dispatcher, per-processor loops - see `Effect.forkDaemon`'s
// primer in EventProcessor.ts) that outlive the single `run()` call that created them, and those
// fibers keep using the SAME pool instance. `ManagedRuntime.make(layer)` builds the layer once,
// keeps it alive, and hands out a `.runPromise` that reuses that same built runtime across as many
// calls as you like - `.dispose()` (called in `after()`) is the only thing that actually tears the
// pool down. This is the general rule: reach for `ManagedRuntime` whenever a test (or a real
// application's `main`) needs one shared, long-lived set of services across many separate
// `run`/`runPromise` calls; reach for plain `Layer` + `Effect.provide` when each call is
// self-contained and can afford to rebuild its own services.
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

const getLastPosition = (viewName: string) =>
  run(makePostgresProgressTracker<string>({ tableName: "crablet_view_progress", idColumn: "view_name" }).pipe(
    Effect.flatMap((t) => t.getLastPosition(viewName))
  ));

const getStatus = (viewName: string) =>
  run(makePostgresProgressTracker<string>({ tableName: "crablet_view_progress", idColumn: "view_name" }).pipe(
    Effect.flatMap((t) => t.getStatus(viewName))
  ));

const progressRowExists = (viewName: string) =>
  run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT 1 FROM crablet_view_progress WHERE view_name = ${viewName}`;
    return rows.length > 0;
  }));

const waitForProcessorIdleTick = async (viewName: string) => {
  await waitUntilAsync(() => progressRowExists(viewName), Boolean);
  // PgClient.listen uses a dedicated connection. Give it the same small registration grace period
  // used by listen-notify.test.ts before sending a NOTIFY that Postgres will not replay.
  await new Promise((resolve) => setTimeout(resolve, 200));
};

interface Harness {
  readonly viewName: string;
  readonly lockKey: bigint;
  readonly handledCounts: Array<number>;
}

const startProcessor = (harness: Harness, options?: { readonly pollingIntervalMs?: number; readonly failAlways?: boolean }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pg = yield* PgClient.PgClient;

    const progressTracker = yield* makePostgresProgressTracker<string>({
      tableName: "crablet_view_progress",
      idColumn: "view_name"
    });
    const fetcher = yield* makeSqlEventFetcher<string>(
      EventSelection.of({ exactTags: new Map([["run_marker", harness.viewName]]) })
    );

    const config = processorConfigOf(harness.viewName, {
      pollingIntervalMs: options?.pollingIntervalMs ?? 60_000,
      batchSize: 100,
      backoffEnabled: false,
      backoffThreshold: 3,
      backoffMultiplier: 2,
      backoffMaxSeconds: 120,
      enabled: true
    });

    const handler = {
      handle: (_id: string, events: ReadonlyArray<unknown>) =>
        options?.failAlways
          ? Effect.fail("simulated permanent failure")
          : Effect.sync(() => {
              harness.handledCounts.push(events.length);
              return events.length;
            })
    };

    const handle = yield* makeEventProcessor({
      configs: [config],
      fetcher,
      handler,
      progressTracker,
      selectionOf: () => EventSelection.empty(),
      instanceId: `instance-${crypto.randomUUID()}`,
      acquireLeader: tryAcquireGlobalLeader(sql, harness.lockKey),
      wakeupStream: wakeupStream(pg, WAKEUP_CHANNEL)
    });

    yield* handle.service.start;
    return handle;
  });

describe("EventProcessor integration (real Postgres: leader election, LISTEN/NOTIFY, full lifecycle)", () => {
  it("only the leader processes: two instances racing the same lockKey share one progress row", { timeout: 20_000 }, async () => {
    const viewName = `poller-integ-leader-${crypto.randomUUID()}`;
    const lockKey = BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);
    const harnessA: Harness = { viewName, lockKey, handledCounts: [] };
    const harnessB: Harness = { viewName, lockKey, handledCounts: [] };

    await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.appendCommutative([
          AppendEvent.of("PollerIntegLeaderEvent", "run_marker", viewName, {})
        ]);
      })
    );

    const [handleA, handleB] = await Promise.all([
      run(startProcessor(harnessA, { pollingIntervalMs: 200 })),
      run(startProcessor(harnessB, { pollingIntervalMs: 200 }))
    ]);

    try {
      await waitUntilAsync(() => getLastPosition(viewName), (p) => p > 0n);

      // Exactly one instance's handler should have received the event - the other stayed a follower
      // and never called process() at all (tick() skips processing entirely when not leader).
      const totalCalls = harnessA.handledCounts.length + harnessB.handledCounts.length;
      assert.strictEqual(totalCalls, 1);
    } finally {
      await run(handleA.service.stop);
      await run(handleB.service.stop);
    }
  });

  it("real LISTEN/NOTIFY triggers an immediate poll well before the configured interval elapses", { timeout: 20_000 }, async () => {
    const viewName = `poller-integ-wakeup-${crypto.randomUUID()}`;
    const lockKey = BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);
    const harness: Harness = { viewName, lockKey, handledCounts: [] };

    // A long polling interval - if the wakeup mechanism weren't real, this test would time out
    // waiting for the assertion below well before the base interval ever elapsed again.
    const handle = await run(startProcessor(harness, { pollingIntervalMs: 60_000 }));

    try {
      await waitForProcessorIdleTick(viewName);

      await run(
        Effect.gen(function* () {
          const store = yield* EventStore;
          const pg = yield* PgClient.PgClient;
          yield* store.appendCommutative([
            AppendEvent.of("PollerIntegWakeupEvent", "run_marker", viewName, {})
          ]);
          // The TS port's EventStoreLive does not yet fire NOTIFY automatically on every append
          // (a known Phase 1 gap - see NOTES.md); this is the same manual notify() Phase 0's
          // listen-notify.test.ts uses, standing in for that future automatic wiring.
          yield* notify(pg, WAKEUP_CHANNEL, encodePayload(new Set(["PollerIntegWakeupEvent"]), new Set()));
        })
      );

      const finalPosition = await waitUntilAsync(() => getLastPosition(viewName), (p) => p > 0n, 5_000);
      assert.ok(finalPosition > 0n, "expected the wakeup to trigger a poll within 5s, well under the 60s interval");
      assert.strictEqual(harness.handledCounts.length, 1);
    } finally {
      await run(handle.service.stop);
    }
  });

  it("stop() releases the leader lock: it is immediately re-acquirable afterwards", { timeout: 20_000 }, async () => {
    const viewName = `poller-integ-stop-${crypto.randomUUID()}`;
    const lockKey = BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);
    const harness: Harness = { viewName, lockKey, handledCounts: [] };

    const handle = await run(startProcessor(harness, { pollingIntervalMs: 200 }));
    try {
      await new Promise((resolve) => setTimeout(resolve, 300)); // let it actually acquire leadership
    } finally {
      await run(handle.service.stop);
    }

    const reacquired = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* tryAcquireGlobalLeader(sql, lockKey);
      })
    );
    assert.ok(reacquired !== null, "expected the lock to be free again immediately after stop()");
    await run(reacquired!.release());
  });

  it("a handler that always fails drives the progress row to FAILED after maxErrors", { timeout: 20_000 }, async () => {
    const viewName = `poller-integ-failed-${crypto.randomUUID()}`;
    const lockKey = BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);
    const harness: Harness = { viewName, lockKey, handledCounts: [] };

    await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.appendCommutative([
          AppendEvent.of("PollerIntegFailedEvent", "run_marker", viewName, {})
        ]);
      })
    );

    const handle = await run(startProcessor(harness, { pollingIntervalMs: 100, failAlways: true }));

    try {
      const status = await waitUntilAsync(() => getStatus(viewName), (s) => s === "FAILED", 10_000);
      assert.strictEqual(status, "FAILED");
    } finally {
      await run(handle.service.stop);
    }
  });
});
