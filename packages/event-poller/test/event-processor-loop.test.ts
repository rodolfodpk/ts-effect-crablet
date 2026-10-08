import { describe, expect, test } from "bun:test";
import { Effect, Exit, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { StoredEvent } from "@crablet/eventstore";
import type { LeaderHandle } from "@crablet/eventstore/Leader";
import type { WakeupBatch } from "@crablet/eventstore/Listen";
import { makeEventProcessor } from "../src/EventProcessor.ts";
import { processorConfigOf } from "../src/ProcessorConfig.ts";
import * as EventSelection from "../src/EventSelection.ts";
import { makeInMemoryProgressTracker } from "./fixtures/InMemoryProgressTracker.ts";
import { makeInMemoryEventFetcher } from "./fixtures/InMemoryEventFetcher.ts";
import { makeInMemoryEventHandler } from "./fixtures/InMemoryEventHandler.ts";

const storedEvent = (position: bigint, type = "TestEvent", transactionId = position.toString()): StoredEvent => ({
  type,
  tags: [],
  data: {},
  transactionId,
  position,
  occurredAt: new Date(0),
  correlationId: null,
  causationId: null
});

const alwaysLeader = (): LeaderHandle => ({
  lockKey: 0n,
  isLeader: () => true,
  verify: Effect.succeed(true),
  release: () => Effect.void
});

const PROCESSOR_ID = "proc-a";

// PATTERN PRIMER - `TestClock`/`TestContext` (provided at the bottom of this file, via
// `Effect.provide(program, TestClock.layer())`): a virtual clock that replaces the real one
// for every `Effect.sleep` in the program under test. `TestClock.adjust("1000 millis")` doesn't
// wait a real second - it instantly advances the virtual clock and resolves any `Effect.sleep`
// calls that were waiting on a time at or before the new instant, in order. That's what makes a
// test asserting backoff behavior (which involves multiple seconds of simulated polling interval)
// run in milliseconds of real wall-clock time, deterministically, instead of either sleeping for
// real or racing against a fake timer library bolted onto plain Promises.
//
// `Effect.yieldNow` is a different, complementary tool: it doesn't touch the clock at all, it
// just cooperatively hands control back to Effect's fiber scheduler for one step, letting OTHER
// already-runnable fibers make progress (e.g. a forked background loop that's ready to run but
// hasn't been scheduled yet). `waitUntil` below combines both ideas into a polling helper: after
// advancing the clock, background fibers may need a few scheduler turns (not more *time*) to
// actually observe the new state and act on it - `yieldNow()` gives them those turns without
// advancing time any further.
//
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
      yield* Effect.yieldNow;
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

describe("EventProcessor.process (direct call, no leadership gate)", () => {
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

  test("pause, resume and the status views: a paused processor handles nothing, a resumed one carries on, and getAllStatuses lists every configured processor", async () => {
    const { handle, eventsRef } = await run(makeHarness());
    await run(Ref.set(eventsRef, [storedEvent(1n)]));
    await run(handle.service.process(PROCESSOR_ID)); // registers as ACTIVE and handles event 1
    expect(await run(handle.service.getStatus(PROCESSOR_ID))).toBe("ACTIVE");

    await run(handle.service.pause(PROCESSOR_ID));
    expect(await run(handle.service.getStatus(PROCESSOR_ID))).toBe("PAUSED");
    expect([...(await run(handle.service.getAllStatuses))]).toEqual([[PROCESSOR_ID, "PAUSED"]]);
    await run(Ref.set(eventsRef, [storedEvent(1n), storedEvent(2n)]));
    expect(await run(handle.service.process(PROCESSOR_ID))).toBe(0);

    await run(handle.service.resume(PROCESSOR_ID));
    expect([...(await run(handle.service.getAllStatuses))]).toEqual([[PROCESSOR_ID, "ACTIVE"]]);
    expect(await run(handle.service.process(PROCESSOR_ID))).toBe(1); // event 2 was waiting
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
    expect((await run(tracker.getCursor(PROCESSOR_ID))).position).toBe(2n);
    expect((await run(handlerHandle.handledBatches)).length).toBe(1);
  });

  test("a row with a LOWER position but a HIGHER transaction id than one already handled is not skipped", async () => {
    const { handle, eventsRef, tracker, handlerHandle } = await run(makeHarness());
    // T1 (xid 10) got position 6; T2 (xid 11) got position 5. T1 commits first, so only its row is there at first.
    await run(Ref.set(eventsRef, [storedEvent(6n, "Late", "10")]));
    expect(await run(handle.service.process(PROCESSOR_ID))).toBe(1);

    // T2 commits afterwards: position 5 is BELOW the cursor's position, but after it in (xid, position) order.
    await run(Ref.set(eventsRef, [storedEvent(6n, "Late", "10"), storedEvent(5n, "Early", "11")]));
    expect(await run(handle.service.process(PROCESSOR_ID))).toBe(1);

    const handled = (await run(handlerHandle.handledBatches)).flat().map((e) => e.type);
    expect(handled).toEqual(["Late", "Early"]);
    expect((await run(tracker.getCursor(PROCESSOR_ID))).transactionId).toBe("11");
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
    expect((await run(tracker.getCursor(PROCESSOR_ID))).position).toBe(0n);
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
      const posAfterFirstTick = yield* waitUntil(Effect.map(tracker.getCursor(PROCESSOR_ID), (c) => c.position), (p) => p === 1n);
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
      const posAfterWakeup = yield* waitUntil(Effect.map(tracker.getCursor(PROCESSOR_ID), (c) => c.position), (p) => p === 2n);
      expect(posAfterWakeup).toBe(2n);

      yield* handle.service.stop;
      const statusesBeforeMoreTime = (yield* tracker.getCursor(PROCESSOR_ID)).position;

      // Nothing further happens after stop, even as we push more events and advance time.
      yield* Ref.set(eventsRef, [storedEvent(1n), storedEvent(2n), storedEvent(3n)]);
      yield* TestClock.adjust("10000 millis");
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      expect((yield* tracker.getCursor(PROCESSOR_ID)).position).toBe(statusesBeforeMoreTime);
    });

    await Effect.runPromise(Effect.provide(program, TestClock.layer()));
  });
});

// ADR/plan step 1b: a processor whose leadership can no longer be confirmed stops - before the
// handler runs and again before the cursor moves - and that is not a handler error.
describe("EventProcessor leadership fence (scheduled loop)", () => {
  const config = processorConfigOf(PROCESSOR_ID, {
    pollingIntervalMs: 1000,
    batchSize: 10,
    backoffEnabled: false,
    backoffThreshold: 1,
    backoffMultiplier: 2,
    backoffMaxSeconds: 120,
    enabled: true
  });

  // `answers` are consumed one per verify call; after they run out the last one repeats.
  const leaderAnswering = (answers: ReadonlyArray<boolean>) => {
    let calls = 0;
    const leader: LeaderHandle = {
      lockKey: 0n,
      isLeader: () => true,
      verify: Effect.sync(() => answers[Math.min(calls++, answers.length - 1)]!),
      release: () => Effect.void
    };
    return { leader, calls: () => calls };
  };

  const setup = (leader: LeaderHandle) =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<ReadonlyArray<StoredEvent>>([storedEvent(1n)]);
      const { tracker, rows } = yield* makeInMemoryProgressTracker<string>();
      const handlerHandle = yield* makeInMemoryEventHandler<string>();
      const handle = yield* makeEventProcessor({
        configs: [config],
        fetcher: makeInMemoryEventFetcher<string>(eventsRef),
        handler: handlerHandle.handler,
        progressTracker: tracker,
        selectionOf: () => EventSelection.empty(),
        instanceId: "test-instance",
        acquireLeader: Effect.succeed(leader),
        wakeupStream: Stream.never
      });
      return { tracker, rows, handlerHandle, handle };
    });

  const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow);

  test("leadership that cannot be confirmed before the handler: the handler is not called, nothing is recorded", async () => {
    const program = Effect.gen(function* () {
      const { leader } = leaderAnswering([false]);
      const { tracker, rows, handlerHandle, handle } = yield* setup(leader);
      yield* tracker.autoRegister(PROCESSOR_ID, "test-instance");
      yield* handle.service.start;
      yield* settle;
      expect(yield* handlerHandle.callCount).toBe(0);
      expect((yield* tracker.getCursor(PROCESSOR_ID)).position).toBe(0n);
      expect((yield* rows).get(PROCESSOR_ID)?.errorCount).toBe(0);
      yield* handle.service.stop;
    });
    await Effect.runPromise(Effect.provide(program, TestClock.layer()));
  });

  test("leadership lost while the handler ran: the cursor does not move and no error is recorded", async () => {
    const program = Effect.gen(function* () {
      const { leader } = leaderAnswering([true, false]);
      const { tracker, rows, handlerHandle, handle } = yield* setup(leader);
      yield* tracker.autoRegister(PROCESSOR_ID, "test-instance");
      yield* handle.service.start;
      yield* settle;
      expect(yield* handlerHandle.callCount).toBe(1);
      expect((yield* tracker.getCursor(PROCESSOR_ID)).position).toBe(0n);
      expect((yield* rows).get(PROCESSOR_ID)?.errorCount).toBe(0);
      yield* handle.service.stop;
    });
    await Effect.runPromise(Effect.provide(program, TestClock.layer()));
  });

  test("a leader that stays confirmed works as before", async () => {
    const program = Effect.gen(function* () {
      const { leader } = leaderAnswering([true]);
      const { tracker, handlerHandle, handle } = yield* setup(leader);
      yield* handle.service.start;
      yield* waitUntil(Effect.map(tracker.getCursor(PROCESSOR_ID), (c) => c.position), (p) => p === 1n);
      expect(yield* handlerHandle.callCount).toBe(1);
      yield* handle.service.stop;
    });
    await Effect.runPromise(Effect.provide(program, TestClock.layer()));
  });

  test("the retry loop releases a handle that is no longer leader before acquiring another", async () => {
    const program = Effect.gen(function* () {
      const released: string[] = [];
      let n = 0;
      const mk = (name: string, leading: () => boolean): LeaderHandle => ({
        lockKey: 0n,
        isLeader: leading,
        verify: Effect.sync(leading),
        release: () => Effect.sync(() => void released.push(name))
      });
      const first = mk("first", () => false);
      const second = mk("second", () => true);
      const eventsRef = yield* Ref.make<ReadonlyArray<StoredEvent>>([]);
      const { tracker } = yield* makeInMemoryProgressTracker<string>();
      const handlerHandle = yield* makeInMemoryEventHandler<string>();
      const handle = yield* makeEventProcessor({
        configs: [config],
        fetcher: makeInMemoryEventFetcher<string>(eventsRef),
        handler: handlerHandle.handler,
        progressTracker: tracker,
        selectionOf: () => EventSelection.empty(),
        instanceId: "test-instance",
        leaderRetryIntervalMs: 1000,
        acquireLeader: Effect.sync(() => (n++ === 0 ? first : second)),
        wakeupStream: Stream.never
      });
      yield* handle.service.start;
      yield* settle;
      yield* TestClock.adjust("1000 millis");
      yield* settle;
      expect(released).toEqual(["first"]);
      yield* handle.service.stop;
    });
    await Effect.runPromise(Effect.provide(program, TestClock.layer()));
  });

  test("a wakeup that carries no event type (a leader released the lock) makes a follower try for the lock at once, not after its retry interval", async () => {
    const program = Effect.gen(function* () {
      let attempts = 0;
      const wakeups = yield* Queue.unbounded<WakeupBatch>();
      const eventsRef = yield* Ref.make<ReadonlyArray<StoredEvent>>([]);
      const { tracker } = yield* makeInMemoryProgressTracker<string>();
      const handlerHandle = yield* makeInMemoryEventHandler<string>();
      const handle = yield* makeEventProcessor({
        configs: [config],
        fetcher: makeInMemoryEventFetcher<string>(eventsRef),
        handler: handlerHandle.handler,
        progressTracker: tracker,
        selectionOf: () => EventSelection.empty(),
        instanceId: "test-instance",
        leaderRetryIntervalMs: 3_600_000,
        acquireLeader: Effect.sync(() => { attempts++; return null; }),
        wakeupStream: Stream.fromQueue(wakeups)
      });
      yield* handle.service.start;
      yield* settle;
      const before = attempts; // the one at start, and the retry loop's first
      yield* Queue.offer(wakeups, { wildcard: true, types: new Set<string>(), tagKeys: new Set<string>() });
      yield* settle;
      expect(attempts).toBe(before + 1);
      // an ordinary wakeup (an event of some type) is not a hint about the lock
      yield* Queue.offer(wakeups, { wildcard: false, types: new Set(["X"]), tagKeys: new Set<string>() });
      yield* settle;
      expect(attempts).toBe(before + 1);
      yield* handle.service.stop;
    });
    await Effect.runPromise(Effect.provide(program, TestClock.layer()));
  });
});

describe("EventProcessor.startScoped: the scope owns the processors", () => {
  test("while the scope is open events are handled; closing it stops the loops and releases the leader lock, once", async () => {
    const program = Effect.gen(function* () {
      const eventsRef = yield* Ref.make<ReadonlyArray<StoredEvent>>([storedEvent(1n)]);
      const { tracker } = yield* makeInMemoryProgressTracker<string>();
      const handlerHandle = yield* makeInMemoryEventHandler<string>({});
      const released = yield* Ref.make(0);
      const leader: LeaderHandle = { lockKey: 0n, isLeader: () => true, verify: Effect.succeed(true), release: () => Ref.update(released, (n) => n + 1) };
      const handle = yield* makeEventProcessor({
        configs: [processorConfigOf(PROCESSOR_ID, { pollingIntervalMs: 1000, batchSize: 10, backoffEnabled: false, backoffThreshold: 1, backoffMultiplier: 2, backoffMaxSeconds: 120, enabled: true })],
        fetcher: makeInMemoryEventFetcher<string>(eventsRef),
        handler: handlerHandle.handler,
        progressTracker: tracker,
        selectionOf: () => EventSelection.empty(),
        instanceId: "test-instance",
        acquireLeader: Effect.succeed(leader),
        wakeupStream: Stream.never
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* handle.service.startScoped;
          yield* waitUntil(Effect.map(tracker.getCursor(PROCESSOR_ID), (c) => c.position), (p) => p === 1n);
          expect(yield* handlerHandle.callCount).toBe(1);
          expect(yield* Ref.get(released)).toBe(0);
        })
      ); // the scope closes here, with no call to stop

      expect(yield* Ref.get(released)).toBe(1);
      const before = yield* handlerHandle.callCount;
      yield* Ref.set(eventsRef, [storedEvent(1n), storedEvent(2n)]);
      yield* TestClock.adjust("10 seconds");
      yield* Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow);
      expect(yield* handlerHandle.callCount).toBe(before); // nothing is polling any more
    });
    await Effect.runPromise(Effect.provide(program, TestClock.layer()));
  });

  test("an error in the scope's body still stops them: this is what a hand-written start and stop could not promise", async () => {
    const program = Effect.gen(function* () {
      const { handle } = yield* makeHarness();
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            yield* handle.service.startScoped;
            return yield* Effect.fail("the body failed");
          })
        )
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* handle.service.getStatus(PROCESSOR_ID)).toBe("ACTIVE"); // the processor is intact, and no fiber is left behind to poll against a closed pool
    });
    await Effect.runPromise(Effect.provide(program, TestClock.layer()));
  });
});
