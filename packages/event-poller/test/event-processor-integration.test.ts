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

// A plain Layer.Layer is rebuilt (a fresh connection pool!) on every single Effect.provide/
// runPromise call - fine for one-shot effects, but fatal here: EventProcessor.start() forks
// long-lived background fibers (leader-retry, dispatcher, per-processor loops) that outlive the
// single `run()` call that created them, and those fibers keep using the SAME pool instance.
// ManagedRuntime keeps one pool alive across every run() call in this file, torn down once via
// dispose() in after() - matching how a real long-running application would hold one pool for its
// entire lifetime.
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

    await waitUntilAsync(
      () => run(makePostgresProgressTracker<string>({ tableName: "crablet_view_progress", idColumn: "view_name" }).pipe(
        Effect.flatMap((t) => t.getLastPosition(viewName))
      )),
      (p) => p > 0n
    );

    // Exactly one instance's handler should have received the event - the other stayed a follower
    // and never called process() at all (tick() skips processing entirely when not leader).
    const totalCalls = harnessA.handledCounts.length + harnessB.handledCounts.length;
    assert.strictEqual(totalCalls, 1);

    await run(handleA.service.stop);
    await run(handleB.service.stop);
  });

  it("real LISTEN/NOTIFY triggers an immediate poll well before the configured interval elapses", { timeout: 20_000 }, async () => {
    const viewName = `poller-integ-wakeup-${crypto.randomUUID()}`;
    const lockKey = BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);
    const harness: Harness = { viewName, lockKey, handledCounts: [] };

    // A long polling interval - if the wakeup mechanism weren't real, this test would time out
    // waiting for the assertion below well before the base interval ever elapsed again.
    const handle = await run(startProcessor(harness, { pollingIntervalMs: 60_000 }));

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

    const finalPosition = await waitUntilAsync(
      () => run(makePostgresProgressTracker<string>({ tableName: "crablet_view_progress", idColumn: "view_name" }).pipe(
        Effect.flatMap((t) => t.getLastPosition(viewName))
      )),
      (p) => p > 0n,
      5_000
    );
    assert.ok(finalPosition > 0n, "expected the wakeup to trigger a poll within 5s, well under the 60s interval");
    assert.strictEqual(harness.handledCounts.length, 1);

    await run(handle.service.stop);
  });

  it("stop() releases the leader lock: it is immediately re-acquirable afterwards", { timeout: 20_000 }, async () => {
    const viewName = `poller-integ-stop-${crypto.randomUUID()}`;
    const lockKey = BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);
    const harness: Harness = { viewName, lockKey, handledCounts: [] };

    const handle = await run(startProcessor(harness, { pollingIntervalMs: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 300)); // let it actually acquire leadership

    await run(handle.service.stop);

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

    const status = await waitUntilAsync(
      () => run(makePostgresProgressTracker<string>({ tableName: "crablet_view_progress", idColumn: "view_name" }).pipe(
        Effect.flatMap((t) => t.getStatus(viewName))
      )),
      (s) => s === "FAILED",
      10_000
    );
    assert.strictEqual(status, "FAILED");

    await run(handle.service.stop);
  });
});
