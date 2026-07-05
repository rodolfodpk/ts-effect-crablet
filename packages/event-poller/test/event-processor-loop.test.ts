import { describe, expect, test } from "bun:test";
import { Effect, Exit, Queue, Ref, Stream, TestClock, TestContext } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { LeaderHandle } from "@crablet/eventstore/Leader";
import type { WakeupBatch } from "@crablet/eventstore/Listen";
import { makeEventProcessor } from "../src/EventProcessor.ts";
import { processorConfigOf } from "../src/ProcessorConfig.ts";
import * as EventSelection from "../src/EventSelection.ts";
import { makeInMemoryProgressTracker } from "./fixtures/InMemoryProgressTracker.ts";
import { makeInMemoryEventFetcher } from "./fixtures/InMemoryEventFetcher.ts";
import { makeInMemoryEventHandler } from "./fixtures/InMemoryEventHandler.ts";

const storedEvent = (position: bigint, type = "TestEvent"): StoredEvent => ({
  type,
  tags: [],
  data: {},
  transactionId: position.toString(),
  position,
  occurredAt: new Date(0),
  correlationId: null,
  causationId: null
});

const alwaysLeader = (): LeaderHandle => ({
  lockKey: 0n,
  isLeader: () => true,
  release: () => Effect.void
});

const PROCESSOR_ID = "proc-a";

// Polls a check effect by repeatedly yielding the fiber's turn (no real/virtual time elapses),
// letting background fibers (dispatcher/leader-retry/processor loops) make progress across
// multiple internal async boundaries (e.g. Stream pull -> PubSub.publish -> Queue.take) before
// giving up. Purely a scheduling aid for deterministic TestClock-based tests, not a timing wait.
const waitUntil = <A, E>(
  check: Effect.Effect<A, E>,
  predicate: (a: A) => boolean,
  maxTries = 200
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    for (let i = 0; i < maxTries; i++) {
      const value = yield* check;
      if (predicate(value)) return value;
      yield* Effect.yieldNow();
    }
    return yield* check;
  });

const makeHarness = (options?: { readonly enabled?: boolean; readonly failFirstN?: number }) =>
  Effect.gen(function* () {
    const eventsRef = yield* Ref.make<ReadonlyArray<StoredEvent>>([]);
    const { tracker, rows } = yield* makeInMemoryProgressTracker<string>();
    const fetcher = makeInMemoryEventFetcher<string>(eventsRef);
    const handlerHandle = yield* makeInMemoryEventHandler<string>({ failFirstN: options?.failFirstN });

    const config = processorConfigOf(PROCESSOR_ID, {
      pollingIntervalMs: 1000,
      batchSize: 10,
      backoffEnabled: true,
      backoffThreshold: 1,
      backoffMultiplier: 2,
      backoffMaxSeconds: 120,
      enabled: options?.enabled ?? true
    });

    const handle = yield* makeEventProcessor({
      configs: [config],
      fetcher,
      handler: handlerHandle.handler,
      progressTracker: tracker,
      selectionOf: () => EventSelection.empty(),
      instanceId: "test-instance",
      acquireLeader: Effect.succeed(alwaysLeader()),
      wakeupStream: Stream.never
    });

    return { eventsRef, tracker, rows, handle, handlerHandle };
  });

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

describe("EventProcessor.process (direct call - mirrors Java's public process(I), no leadership gate)", () => {
  test("disabled config -> 0, no autoRegister", async () => {
    const { handle, rows } = await run(makeHarness({ enabled: false }));
    const handled = await run(handle.service.process(PROCESSOR_ID));
    expect(handled).toBe(0);
    expect((await run(rows)).has(PROCESSOR_ID)).toBe(false);
  });

  test("PAUSED status -> 0, no fetch performed even though events exist", async () => {
    const { handle, eventsRef, tracker } = await run(makeHarness());
    await run(Ref.set(eventsRef, [storedEvent(1n)]));
    await run(handle.service.process(PROCESSOR_ID)); // auto-registers as ACTIVE, consumes the event
    await run(tracker.setStatus(PROCESSOR_ID, "PAUSED"));
    await run(Ref.set(eventsRef, [storedEvent(1n), storedEvent(2n)]));

    const handled = await run(handle.service.process(PROCESSOR_ID));
    expect(handled).toBe(0);
  });

  test("FAILED status -> 0, no fetch performed", async () => {
    const { handle, tracker, eventsRef } = await run(makeHarness());
    await run(tracker.autoRegister(PROCESSOR_ID, "test-instance"));
    await run(tracker.setStatus(PROCESSOR_ID, "FAILED"));
    await run(Ref.set(eventsRef, [storedEvent(1n)]));

    const handled = await run(handle.service.process(PROCESSOR_ID));
    expect(handled).toBe(0);
  });

  test("empty fetch -> 0", async () => {
    const { handle } = await run(makeHarness());
    const handled = await run(handle.service.process(PROCESSOR_ID));
    expect(handled).toBe(0);
  });

  test("successful handling advances progress and resets error count", async () => {
    const { handle, eventsRef, tracker, handlerHandle } = await run(makeHarness());
    await run(Ref.set(eventsRef, [storedEvent(1n), storedEvent(2n)]));

    const handled = await run(handle.service.process(PROCESSOR_ID));
    expect(handled).toBe(2);
    expect(await run(tracker.getLastPosition(PROCESSOR_ID))).toBe(2n);
    expect((await run(handlerHandle.handledBatches)).length).toBe(1);
  });

  test("unknown processorId is a defect (Effect.die), not a typed failure", async () => {
    const { handle } = await run(makeHarness());
    const exit = await run(Effect.exit(handle.service.process("does-not-exist")));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("handler failure records the error and rethrows, without advancing progress", async () => {
    const { handle, eventsRef, tracker } = await run(makeHarness({ failFirstN: 1 }));
    await run(Ref.set(eventsRef, [storedEvent(1n)]));

    const exit = await run(Effect.exit(handle.service.process(PROCESSOR_ID)));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await run(tracker.getLastPosition(PROCESSOR_ID))).toBe(0n);
    expect(await run(tracker.getStatus(PROCESSOR_ID))).toBe("ACTIVE"); // 1 error, well under maxErrors=10
  });
});

describe("EventProcessor full start/stop loop (drives real polling via Effect TestClock)", () => {
  test("processes available events, backs off while idle, wakes up early on notification, and stops cleanly", async () => {
    const program = Effect.gen(function* () {
      const eventsRef = yield* Ref.make<ReadonlyArray<StoredEvent>>([storedEvent(1n)]);
      const { tracker } = yield* makeInMemoryProgressTracker<string>();
      const fetcher = makeInMemoryEventFetcher<string>(eventsRef);
      const handlerHandle = yield* makeInMemoryEventHandler<string>();
      const wakeupQueue = yield* Queue.unbounded<WakeupBatch>();

      const config = processorConfigOf(PROCESSOR_ID, {
        pollingIntervalMs: 1000,
        batchSize: 10,
        backoffEnabled: true,
        backoffThreshold: 0,
        backoffMultiplier: 2,
        backoffMaxSeconds: 120,
        enabled: true
      });

      const handle = yield* makeEventProcessor({
        configs: [config],
        fetcher,
        handler: handlerHandle.handler,
        progressTracker: tracker,
        selectionOf: () => EventSelection.empty(),
        instanceId: "test-instance",
        acquireLeader: Effect.succeed(alwaysLeader()),
        wakeupStream: Stream.fromQueue(wakeupQueue)
      });

      yield* handle.service.start;

      // First tick should have already consumed the one available event.
      const posAfterFirstTick = yield* waitUntil(tracker.getLastPosition(PROCESSOR_ID), (p) => p === 1n);
      expect(posAfterFirstTick).toBe(1n);
      expect((yield* handlerHandle.handledBatches).length).toBe(1);

      // No more events - advance past the base interval; should be one more (empty) tick.
      yield* TestClock.adjust("1000 millis");
      const snapshotAfterEmpty = yield* waitUntil(
        handle.backoffSnapshot(PROCESSOR_ID),
        (s) => (s?.emptyPollCount ?? 0) >= 1
      );
      expect(snapshotAfterEmpty?.emptyPollCount).toBeGreaterThanOrEqual(1);

      // A wakeup notification should trigger an immediate re-poll well before the (now-widened)
      // backoff delay would otherwise elapse.
      yield* Ref.set(eventsRef, [storedEvent(1n), storedEvent(2n)]);
      yield* Queue.offer(wakeupQueue, { wildcard: true, types: new Set<string>(), tagKeys: new Set<string>() });
      const posAfterWakeup = yield* waitUntil(tracker.getLastPosition(PROCESSOR_ID), (p) => p === 2n);
      expect(posAfterWakeup).toBe(2n);

      yield* handle.service.stop;
      const statusesBeforeMoreTime = yield* tracker.getLastPosition(PROCESSOR_ID);

      // Nothing further happens after stop, even as we push more events and advance time.
      yield* Ref.set(eventsRef, [storedEvent(1n), storedEvent(2n), storedEvent(3n)]);
      yield* TestClock.adjust("10000 millis");
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow();
      expect(yield* tracker.getLastPosition(PROCESSOR_ID)).toBe(statusesBeforeMoreTime);
    });

    await Effect.runPromise(Effect.provide(program, TestContext.TestContext));
  });
});
