// The paths of the event processor the loop tests do not take: a batch in one transaction (`atomically`), a cursor someone else moved, a progress
// table that is not there yet, a follower, a lock that cannot be asked for, wake-ups for other types, the poll metrics, and the stream of wake-ups
// failing. All in memory, with the TestClock where the loop runs.
import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Logger, Metric, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { StoredEvent } from "@crablet/eventstore";
import type { LeaderHandle } from "@crablet/eventstore/Leader";
import type { WakeupBatch } from "@crablet/eventstore/Listen";
import * as LeaderMetrics from "@crablet/metrics-otel/LeaderMetrics";
import * as PollerMetrics from "@crablet/metrics-otel/PollerMetrics";
import { makeEventProcessor, type EventProcessorDeps } from "../src/EventProcessor.ts";
import { HandledPrefix, type EventHandler } from "../src/EventHandler.ts";
import { defaultPollingConfig, processorConfigOf, type ProcessorConfig } from "../src/ProcessorConfig.ts";
import { ProgressTableNotReady, type ProgressTracker } from "../src/ProgressTracker.ts";
import * as EventSelection from "../src/EventSelection.ts";
import { makeInMemoryProgressTracker } from "./fixtures/InMemoryProgressTracker.ts";
import { makeInMemoryEventFetcher } from "./fixtures/InMemoryEventFetcher.ts";
import { makeInMemoryEventHandler } from "./fixtures/InMemoryEventHandler.ts";

const ID = "paths";
const storedEvent = (position: bigint, type = "A"): StoredEvent => ({
  eventId: crypto.randomUUID(),
  type,
  tags: [],
  data: {},
  transactionId: position.toString(),
  position,
  occurredAt: new Date(0),
  correlationId: null,
  causationId: null
});
const leaderOf = (isLeader: () => boolean = () => true): LeaderHandle => ({ lockKey: 0n, isLeader, verify: Effect.sync(isLeader), release: () => Effect.void });
const quiet = { pollingIntervalMs: 1000, batchSize: 10, backoffEnabled: false, backoffThreshold: 1, backoffMultiplier: 2, backoffMaxSeconds: 120 };
const wakeup = (types: ReadonlyArray<string>): WakeupBatch => ({ wildcard: false, types: new Set(types), tagKeys: new Set() });
const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow);

// The processor over in-memory parts; `tracker` and the deps can be changed piece by piece.
const build = (options: {
  readonly events?: ReadonlyArray<StoredEvent>;
  readonly id?: string;
  readonly config?: Partial<typeof quiet>;
  readonly tracker?: (t: ProgressTracker<string>) => ProgressTracker<string>;
  readonly handler?: EventHandler<string, unknown, never>;
  readonly deps?: Partial<EventProcessorDeps<ProcessorConfig<string>, string>>;
} = {}) =>
  Effect.gen(function* () {
    const id = options.id ?? ID;
    const eventsRef = yield* Ref.make<ReadonlyArray<StoredEvent>>(options.events ?? [storedEvent(1n), storedEvent(2n)]);
    const { tracker: base, rows } = yield* makeInMemoryProgressTracker<string>();
    const tracker = options.tracker?.(base) ?? base;
    const handlerHandle = yield* makeInMemoryEventHandler<string>();
    const handle = yield* makeEventProcessor({
      configs: [processorConfigOf(id, { ...quiet, ...options.config })],
      fetcher: makeInMemoryEventFetcher(eventsRef),
      handler: options.handler ?? handlerHandle.handler,
      progressTracker: tracker,
      selectionOf: () => EventSelection.empty(),
      instanceId: "paths-instance",
      acquireLeader: Effect.succeed(leaderOf()),
      wakeupStream: Stream.never,
      ...options.deps
    } as EventProcessorDeps<ProcessorConfig<string>, string>);
    const errorCount = Effect.map(rows, (r) => r.get(id)?.errorCount);
    const position = Effect.map(base.getCursor(id), (c) => c.position);
    return { handle, tracker: base, rows, errorCount, position, eventsRef, handlerHandle, id };
  });
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
// Runs `effect` with the warnings and errors it logs collected.
const logged = async <A, E>(effect: Effect.Effect<A, E>): Promise<ReadonlyArray<string>> => {
  const lines: Array<string> = [];
  const capture = Logger.layer([Logger.make((o) => void lines.push(`${o.logLevel} ${String(o.message)}`))], { mergeWithExisting: false });
  await Effect.runPromise(Effect.provide(effect, capture));
  return lines.filter((l) => !l.startsWith("Info") && !l.startsWith("Debug"));
};
const inClock = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.provide(effect, TestClock.layer()));

describe("a batch in one transaction (atomically, with advanceCursor)", () => {
  test("the handler and the cursor move inside it, and a success resets the error count", async () => {
    let transactions = 0;
    const { handle, tracker, errorCount, position, id } = await run(build({ deps: { atomically: (effect) => Effect.andThen(Effect.sync(() => void transactions++), effect) } }));
    await run(Effect.andThen(tracker.autoRegister(id, "i"), tracker.recordError(id, "earlier", 10)));
    expect(await run(handle.service.process(id))).toBe(2);
    expect([transactions, await run(position), await run(errorCount)]).toEqual([1, 2n, 0]);
  });

  test("a handler failure is recorded after the transaction, not inside it, and fails with the handler's own error", async () => {
    let inside = false;
    const recordedInside: Array<boolean> = [];
    const failing: EventHandler<string, unknown, never> = { handle: () => Effect.fail("handler broke") };
    const { handle, position, errorCount, id } = await run(
      build({
        handler: failing,
        tracker: (t) => ({ ...t, recordError: (i, e, m) => Effect.andThen(Effect.sync(() => void recordedInside.push(inside)), t.recordError(i, e, m)) }),
        deps: { atomically: (effect) => Effect.ensuring(Effect.andThen(Effect.sync(() => void (inside = true)), effect), Effect.sync(() => void (inside = false))) }
      })
    );
    const exit = await run(Effect.exit(handle.service.process(id)));
    expect(Exit.isFailure(exit) && Cause.findErrorOption(exit.cause)).toEqual(expect.objectContaining({ value: "handler broke" }));
    expect(recordedInside).toEqual([false]);
    expect([await run(position), await run(errorCount)]).toEqual([0n, 1]);
  });

  test("a handler that handled none of the batch still succeeded: the error count is reset", async () => {
    const none: EventHandler<string, unknown, never> = { handle: () => Effect.succeed(0) };
    const { handle, tracker, errorCount, id } = await run(build({ handler: none, deps: { atomically: (effect) => effect } }));
    await run(Effect.andThen(tracker.autoRegister(id, "i"), tracker.recordError(id, "earlier", 10)));
    expect(await run(handle.service.process(id))).toBe(0);
    expect(await run(errorCount)).toBe(0);
  });

  test("with atomically but a tracker that has no advanceCursor, the batch is handled without a transaction", async () => {
    let transactions = 0;
    const { handle, position, id } = await run(
      build({ tracker: ({ advanceCursor: _, ...rest }) => rest, deps: { atomically: (effect) => Effect.andThen(Effect.sync(() => void transactions++), effect) } })
    );
    expect(await run(handle.service.process(id))).toBe(2);
    expect([transactions, await run(position)]).toEqual([0, 2n]);
  });

  test("a cursor someone else moved first: the batch is rolled back, answers 0, and records nothing (the error count stays as it was)", async () => {
    const { handle, tracker, errorCount, id } = await run(
      build({ tracker: (t) => ({ ...t, advanceCursor: () => Effect.succeed(false) }), deps: { atomically: (effect) => effect } })
    );
    await run(Effect.andThen(tracker.autoRegister(id, "i"), tracker.recordError(id, "earlier", 10)));
    expect(await run(handle.service.process(id))).toBe(0);
    expect(await run(errorCount)).toBe(1);
  });
});

describe("a batch without a transaction", () => {
  test("a cursor someone else moved first: the batch was handled twice, which at-least-once allows; it counts, and the error count is reset", async () => {
    const { handle, tracker, errorCount, id } = await run(build({ tracker: (t) => ({ ...t, advanceCursor: () => Effect.succeed(false) }) }));
    await run(Effect.andThen(tracker.autoRegister(id, "i"), tracker.recordError(id, "earlier", 10)));
    const lines = await logged(Effect.flatMap(handle.service.process(id), (n) => Effect.sync(() => expect(n).toBe(2))));
    expect(lines).toEqual([`Warn processor ${id}: another processor moved the cursor first; this batch was handled twice`]);
    expect(await run(errorCount)).toBe(0);
  });

  test("a cursor that moved says nothing; a tracker with no advanceCursor moves it with updateCursor, and says nothing either", async () => {
    const moved = await run(build());
    expect(await logged(moved.handle.service.process(moved.id))).toEqual([]);
    const { handle, position, id } = await run(build({ tracker: ({ advanceCursor: _, ...rest }) => rest }));
    expect(await logged(handle.service.process(id))).toEqual([]);
    expect(await run(position)).toBe(2n);
  });

  test("a handler that fails on the first event of the batch moves no cursor, and its cause is what is recorded", async () => {
    let moves = 0;
    const failing: EventHandler<string, unknown, never> = { handle: () => Effect.fail(new HandledPrefix({ handled: 0, cause: "first one broke" })) };
    const { handle, position, errorCount, id } = await run(
      build({ handler: failing, tracker: (t) => ({ ...t, updateCursor: (i, f, to) => Effect.andThen(Effect.sync(() => void moves++), t.updateCursor(i, f, to)) }) })
    );
    const exit = await run(Effect.exit(handle.service.process(id)));
    expect(Exit.isFailure(exit) && Cause.findErrorOption(exit.cause)).toEqual(expect.objectContaining({ value: "first one broke" }));
    expect([moves, await run(position), await run(errorCount)]).toEqual([0, 0n, 1]);
  });
});

describe("process: before any batch", () => {
  test("a progress table that does not exist yet: nothing is fetched or handled", async () => {
    const { handle, handlerHandle, id } = await run(build({ tracker: (t) => ({ ...t, getCursor: () => Effect.fail(new ProgressTableNotReady()) }) }));
    expect(await run(handle.service.process(id))).toBe(0);
    expect(await run(handlerHandle.callCount)).toBe(0);
  });

  test("an unknown processor id is a defect that names it", async () => {
    const { handle } = await run(build());
    const exit = await run(Effect.exit(handle.service.process("nobody")));
    expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain("Unknown processorId: nobody");
  });
});

describe("the loop: leadership", () => {
  test("a follower handles nothing and says it does not lead; it leads at the default retry interval once the lock is free, and the gauge says so", async () => {
    const gauge = Effect.map(Metric.value(Metric.withAttributes(LeaderMetrics.leadership, { lock_key: "0", instance_id: "follower-instance" })), (s) => (s as unknown as { value: number }).value);
    const result = await inClock(
      Effect.gen(function* () {
        let free = false;
        const { handle, position } = yield* build({ deps: { instanceId: "follower-instance", acquireLeader: Effect.sync(() => (free ? leaderOf() : null)) } });
        yield* handle.service.start;
        yield* settle;
        const before = { position: yield* position, leads: yield* handle.isLeader };
        free = true;
        yield* TestClock.adjust(defaultPollingConfig.leaderElectionRetryIntervalMs - 1);
        yield* settle;
        const justBefore = yield* handle.isLeader;
        yield* TestClock.adjust(1);
        yield* settle;
        const after = { leads: yield* handle.isLeader, gauge: yield* gauge };
        yield* TestClock.adjust(1000);
        yield* settle;
        const handled = yield* position;
        yield* handle.service.stop;
        return { before, justBefore, after, handled };
      })
    );
    expect(result).toEqual({ before: { position: 0n, leads: false }, justBefore: false, after: { leads: true, gauge: 1 }, handled: 2n });
  });

  test("a lock that cannot be asked for is logged and asked for again, not fatal", async () => {
    const result = await inClock(
      Effect.gen(function* () {
        let attempts = 0;
        const acquireLeader = Effect.suspend(() => (attempts++ === 0 ? Effect.fail("db down") : Effect.succeed(leaderOf())));
        const { handle, position } = yield* build({ deps: { acquireLeader, leaderRetryIntervalMs: 100 } as never });
        yield* handle.service.start;
        yield* TestClock.adjust(100);
        yield* settle;
        yield* TestClock.adjust(1000);
        yield* settle;
        const handled = yield* position;
        yield* handle.service.stop;
        return { attempts, handled };
      })
    );
    expect(result.handled).toBe(2n);
    expect(result.attempts).toBeGreaterThanOrEqual(2);
  });

  test("a handler failure is logged as an error; a leadership that cannot be confirmed as a warning, without the error", async () => {
    const lines: Array<string> = [];
    const capture = Logger.layer([Logger.make((o) => void lines.push(`${o.logLevel} ${String(o.message)}`))], { mergeWithExisting: false });
    const failing: EventHandler<string, unknown, never> = { handle: () => Effect.fail("handler broke") };
    const loop = (leader: LeaderHandle) =>
      Effect.gen(function* () {
        const { handle } = yield* build({ handler: failing, deps: { acquireLeader: Effect.succeed(leader) } });
        yield* handle.service.start;
        yield* settle;
        yield* handle.service.stop;
      });
    await Effect.runPromise(Effect.provide(loop(leaderOf()), Layer.mergeAll(TestClock.layer(), capture)));
    expect(lines.some((l) => l.startsWith("Error") && l.includes("handler broke"))).toBe(true);
    lines.length = 0;
    await Effect.runPromise(Effect.provide(loop({ ...leaderOf(), verify: Effect.succeed(false) }), Layer.mergeAll(TestClock.layer(), capture)));
    expect(lines.some((l) => l.startsWith("Warn") && l.includes("leadership lost, tick stopped"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Error"))).toBe(false);
  });
});

describe("the loop: wake-ups", () => {
  test("a wake-up for types the processor does not read does not wake it; one for a type it reads does", async () => {
    const result = await inClock(
      Effect.gen(function* () {
        const wakeups = yield* Queue.unbounded<WakeupBatch>();
        const { handle, eventsRef, position } = yield* build({
          events: [],
          deps: { wakeupStream: Stream.fromQueue(wakeups), selectionOf: () => EventSelection.of({ eventTypes: new Set(["A"]) }) }
        });
        yield* handle.service.start;
        yield* settle;
        yield* Ref.set(eventsRef, [storedEvent(1n)]);
        yield* Queue.offer(wakeups, wakeup(["B"]));
        yield* settle;
        const afterOther = yield* position;
        yield* Queue.offer(wakeups, wakeup(["A"]));
        yield* settle;
        const afterOwn = yield* position;
        yield* handle.service.stop;
        return { afterOther, afterOwn };
      })
    );
    expect(result).toEqual({ afterOther: 0n, afterOwn: 1n });
  });

  test("a stream of wake-ups that fails is drained again a second later", async () => {
    const result = await inClock(
      Effect.gen(function* () {
        const wakeups = yield* Queue.unbounded<WakeupBatch>();
        let runs = 0;
        const wakeupStream = Stream.suspend(() => (runs++ === 0 ? Stream.fail("listen broke") : Stream.fromQueue(wakeups)));
        const { handle, eventsRef, position } = yield* build({ events: [], config: { pollingIntervalMs: 60_000 }, deps: { wakeupStream } });
        yield* handle.service.start;
        yield* settle;
        yield* TestClock.adjust(1000);
        yield* settle;
        yield* Ref.set(eventsRef, [storedEvent(1n)]);
        yield* Queue.offer(wakeups, wakeup(["A"]));
        yield* settle;
        const handled = yield* position;
        yield* handle.service.stop;
        return { runs, handled };
      })
    );
    expect(result).toEqual({ runs: 2, handled: 1n });
  });
});

describe("the loop: metrics and backoff", () => {
  test("each poll is counted by processor and instance: cycles, events and empty polls; the backoff gauges follow the backoff", async () => {
    const tags = { processor: "metrics-proc", instance_id: "paths-instance" };
    const count = (metric: Metric.Metric<number, unknown>) => Effect.map(Metric.value(Metric.withAttributes(metric, tags)), (s) => (s as unknown as { count?: number; value?: number }).count ?? (s as { value: number }).value);
    const result = await inClock(
      Effect.gen(function* () {
        const { handle } = yield* build({ id: "metrics-proc", config: { backoffEnabled: true, backoffThreshold: 1 } });
        yield* handle.service.start;
        yield* settle; // one poll: 2 events
        for (let i = 0; i < 3; i++) {
          yield* TestClock.adjust(10_000);
          yield* settle; // empty polls
        }
        const values = {
          cycles: yield* count(PollerMetrics.processingCycles),
          events: yield* count(PollerMetrics.eventsFetched),
          empty: yield* count(PollerMetrics.emptyPolls),
          backoffActive: yield* count(PollerMetrics.backoffActive as never),
          snapshot: yield* handle.backoffSnapshot("metrics-proc")
        };
        const all = yield* handle.allBackoffSnapshots;
        yield* handle.service.stop;
        return { ...values, all: [...all.keys()] };
      })
    );
    expect(result.events).toBe(2);
    expect(result.cycles).toBeGreaterThanOrEqual(3);
    expect(result.empty).toBe(result.cycles - 1);
    expect(result.backoffActive).toBe((result.snapshot?.currentSkipCounter ?? 0) > 0 ? 1 : 0);
    expect(result.snapshot?.emptyPollCount).toBeGreaterThanOrEqual(2);
    expect(result.all).toEqual(["metrics-proc"]);
  });

  test("the backoff gauge is 0 while the processor finds events", async () => {
    const tags = { processor: "busy-proc", instance_id: "paths-instance" };
    const active = await inClock(
      Effect.gen(function* () {
        const { handle } = yield* build({ id: "busy-proc", config: { backoffEnabled: true, backoffThreshold: 0 } });
        yield* handle.service.start;
        yield* settle;
        const value = yield* Metric.value(Metric.withAttributes(PollerMetrics.backoffActive, tags));
        yield* handle.service.stop;
        return (value as unknown as { value: number }).value;
      })
    );
    expect(active).toBe(0);
  });

  test("a batch that finds events ends the backoff; a failed one leaves it as it was", async () => {
    const result = await inClock(
      Effect.gen(function* () {
        let fail = false;
        const handler: EventHandler<string, unknown, never> = { handle: (_, events) => (fail ? Effect.fail("broke") : Effect.succeed(events.length)) };
        const wakeups = yield* Queue.unbounded<WakeupBatch>();
        const { handle, eventsRef } = yield* build({ events: [], handler, config: { backoffEnabled: true, backoffThreshold: 0 }, deps: { wakeupStream: Stream.fromQueue(wakeups) } });
        // A wake-up polls at once, whatever the backoff's delay.
        const poll = Effect.andThen(Queue.offer(wakeups, wakeup(["A"])), settle);
        yield* handle.service.start;
        yield* settle;
        yield* poll;
        yield* poll;
        const idle = yield* handle.backoffSnapshot(ID);
        fail = true;
        yield* Ref.set(eventsRef, [storedEvent(1n)]);
        yield* poll;
        const afterFailure = yield* handle.backoffSnapshot(ID);
        fail = false;
        yield* poll;
        const afterEvents = yield* handle.backoffSnapshot(ID);
        yield* handle.service.stop;
        return { idle, afterFailure, afterEvents };
      })
    );
    expect(result.idle?.emptyPollCount).toBe(3);
    expect(result.afterFailure).toEqual(result.idle);
    expect(result.afterEvents).toEqual(expect.objectContaining({ emptyPollCount: 0, currentSkipCounter: 0 }));
  });
});

describe("start and stop", () => {
  test("stop before start, and stop twice, do nothing", async () => {
    const { handle } = await run(build());
    await run(handle.service.stop);
    await inClock(Effect.gen(function* () {
      yield* handle.service.start;
      yield* handle.service.stop;
      yield* handle.service.stop;
    }));
  });
});
