// What a processor tells a tracer and a log: a span for a batch that was handled (and none for an idle poll), and log lines that say which processor and instance wrote them.
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Logger, References, Ref, Stream, Tracer } from "effect";
import { TestClock } from "effect/testing";
import type { StoredEvent } from "@crablet/eventstore";
import type { LeaderHandle } from "@crablet/eventstore/Leader";
import { makeEventProcessor } from "../src/EventProcessor.ts";
import { processorConfigOf } from "../src/ProcessorConfig.ts";
import * as EventSelection from "../src/EventSelection.ts";
import { makeInMemoryProgressTracker } from "./fixtures/InMemoryProgressTracker.ts";
import { makeInMemoryEventFetcher } from "./fixtures/InMemoryEventFetcher.ts";
import { makeInMemoryEventHandler } from "./fixtures/InMemoryEventHandler.ts";

const event = (position: bigint): StoredEvent => ({ type: "T", tags: [], data: {}, transactionId: position.toString(), position, occurredAt: new Date(0), correlationId: null, causationId: null });
const PROCESSOR_ID = "proc-a";
const config = processorConfigOf(PROCESSOR_ID, { pollingIntervalMs: 1000, batchSize: 10, backoffEnabled: false, backoffThreshold: 1, backoffMultiplier: 2, backoffMaxSeconds: 120, enabled: true });

// A tracer that is the library's own, and also keeps every span it hands out.
const recordingTracer = () => {
  const spans: Array<Tracer.Span> = [];
  const tracer = Tracer.make({
    span(this: Tracer.Tracer, options) {
      const span = Tracer.nativeTracer.span.call(this, options);
      spans.push(span);
      return span;
    }
  });
  return { tracer, spans };
};

const build = (events: ReadonlyArray<StoredEvent>, leader?: LeaderHandle) =>
  Effect.gen(function* () {
    const eventsRef = yield* Ref.make<ReadonlyArray<StoredEvent>>(events);
    const { tracker } = yield* makeInMemoryProgressTracker<string>();
    const handlerHandle = yield* makeInMemoryEventHandler<string>({});
    return yield* makeEventProcessor({
      configs: [config],
      fetcher: makeInMemoryEventFetcher<string>(eventsRef),
      handler: handlerHandle.handler,
      progressTracker: tracker,
      selectionOf: () => EventSelection.empty(),
      instanceId: "instance-7",
      acquireLeader: Effect.succeed(leader ?? { lockKey: 0n, isLeader: () => true, verify: Effect.succeed(true), release: () => Effect.void }),
      wakeupStream: Stream.never
    });
  });

describe("tracing", () => {
  test("a poll that handles events is one span with the processor and the batch size; an idle poll is none", async () => {
    const { tracer, spans } = recordingTracer();
    const program = Effect.gen(function* () {
      const handle = yield* build([event(1n), event(2n)]);
      yield* handle.service.process(PROCESSOR_ID); // handles both events
      yield* handle.service.process(PROCESSOR_ID); // nothing new
    });
    await Effect.runPromise(Effect.withTracer(program, tracer));
    const batches = spans.filter((s) => s.name === "crablet.poller.batch");
    expect(batches).toHaveLength(1);
    expect(batches[0]!.attributes.get("crablet.processor")).toBe(PROCESSOR_ID);
    expect(batches[0]!.attributes.get("crablet.batch.events")).toBe(2);
    expect(batches[0]!.status._tag).toBe("Ended");
  });

  test("a handler that fails ends the span as a failure, so the trace shows which batch went wrong", async () => {
    const { tracer, spans } = recordingTracer();
    const program = Effect.gen(function* () {
      const eventsRef = yield* Ref.make<ReadonlyArray<StoredEvent>>([event(1n)]);
      const { tracker } = yield* makeInMemoryProgressTracker<string>();
      const handlerHandle = yield* makeInMemoryEventHandler<string>({ failFirstN: 1 });
      const handle = yield* makeEventProcessor({
        configs: [config],
        fetcher: makeInMemoryEventFetcher<string>(eventsRef),
        handler: handlerHandle.handler,
        progressTracker: tracker,
        selectionOf: () => EventSelection.empty(),
        instanceId: "instance-7",
        acquireLeader: Effect.succeed({ lockKey: 0n, isLeader: () => true, verify: Effect.succeed(true), release: () => Effect.void }),
        wakeupStream: Stream.never
      });
      yield* Effect.ignore(handle.service.process(PROCESSOR_ID));
    });
    await Effect.runPromise(Effect.withTracer(program, tracer));
    const span = spans.find((s) => s.name === "crablet.poller.batch")!;
    expect(span.status._tag === "Ended" && span.status.exit._tag).toBe("Failure");
  });
});

describe("log context", () => {
  test("a line written by a processor's loop carries the processor and the instance", async () => {
    const lines: Array<{ message: unknown; annotations: Record<string, unknown> }> = [];
    const capture = Logger.make((options) => {
      lines.push({ message: options.message, annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) } });
    });
    // leadership that cannot be confirmed before the handler logs a warning from inside the loop
    const leader: LeaderHandle = { lockKey: 0n, isLeader: () => true, verify: Effect.succeed(false), release: () => Effect.void };
    const program = Effect.gen(function* () {
      const handle = yield* build([event(1n)], leader);
      yield* handle.service.start;
      yield* Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow);
      yield* handle.service.stop;
    });
    await Effect.runPromise(Effect.provide(program, Layer.mergeAll(TestClock.layer(), Logger.layer([capture], { mergeWithExisting: false }))));
    const fromLoop = lines.filter((l) => String(l.message).includes("processor proc-a"));
    expect(fromLoop.length).toBeGreaterThan(0);
    expect(fromLoop[0]!.annotations).toMatchObject({ processor: PROCESSOR_ID, instance: "instance-7" });
  });
});
