import { describe, expect, test } from "bun:test";
import { Cause, Effect } from "effect";
import { HandledPrefix } from "@crablet/event-poller/EventHandler";
import type { StoredEvent } from "@crablet/eventstore";
import { makeOutboxEventHandler } from "../src/internal/OutboxEventHandler.ts";
import { toKey } from "../src/TopicPublisherPair.ts";
import type { OutboxPublisher } from "../src/OutboxPublisher.ts";

const fakeEvent = (type: string): StoredEvent => ({
  eventId: crypto.randomUUID(),
  type,
  tags: [],
  data: {},
  transactionId: "1",
  position: 1n,
  occurredAt: new Date(),
  correlationId: null,
  causationId: null
});

describe("makeOutboxEventHandler", () => {
  test("routes to the publisher matching the pair key's publisher name", async () => {
    const seenKafka: Array<ReadonlyArray<StoredEvent>> = [];
    const seenWebhook: Array<ReadonlyArray<StoredEvent>> = [];
    const kafka: OutboxPublisher = { name: "kafka", publishBatch: (events) => Effect.sync(() => void seenKafka.push(events)) };
    const webhook: OutboxPublisher = { name: "webhook", publishBatch: (events) => Effect.sync(() => void seenWebhook.push(events)) };

    const handler = makeOutboxEventHandler([kafka, webhook]);
    const events = [fakeEvent("OrderPlaced")];
    const handled = await Effect.runPromise(handler.handle(toKey({ topic: "orders", publisher: "webhook" }), events));

    expect(handled).toBe(1);
    expect(seenKafka).toEqual([]);
    expect(seenWebhook).toEqual([events]);
  });

  test("calls publishBatch once for the whole batch when preferredMode is 'batch' (default)", async () => {
    const calls: Array<ReadonlyArray<StoredEvent>> = [];
    const publisher: OutboxPublisher = { name: "kafka", publishBatch: (events) => Effect.sync(() => void calls.push(events)) };
    const handler = makeOutboxEventHandler([publisher]);
    const events = [fakeEvent("A"), fakeEvent("B")];

    await Effect.runPromise(handler.handle(toKey({ topic: "orders", publisher: "kafka" }), events));

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(events);
  });

  test("calls publishBatch once per event when preferredMode is 'individual'", async () => {
    const calls: Array<ReadonlyArray<StoredEvent>> = [];
    const publisher: OutboxPublisher = {
      name: "webhook",
      preferredMode: "individual",
      publishBatch: (events) => Effect.sync(() => void calls.push(events))
    };
    const handler = makeOutboxEventHandler([publisher]);
    const events = [fakeEvent("A"), fakeEvent("B")];

    const handled = await Effect.runPromise(handler.handle(toKey({ topic: "orders", publisher: "webhook" }), events));

    expect(handled).toBe(2);
    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual([events[0]]);
    expect(calls[1]).toEqual([events[1]]);
  });

  test("dies on an unregistered publisher name", async () => {
    const handler = makeOutboxEventHandler([]);
    await expect(
      Effect.runPromise(handler.handle(toKey({ topic: "orders", publisher: "unknown" }), []))
    ).rejects.toThrow();
  });
});

// ADR-0036: a publish has a time limit, and a publisher that sends one event at a time keeps what it sent when a later one fails.
describe("makeOutboxEventHandler: a slow or failing destination", () => {
  test("a publish that takes longer than publishTimeoutMs fails, naming the publisher and the limit", async () => {
    const stuck: OutboxPublisher = { name: "stuck", publishBatch: () => Effect.never };
    const handler = makeOutboxEventHandler([stuck], 50);
    const exit = await Effect.runPromiseExit(handler.handle(toKey({ topic: "orders", publisher: "stuck" }), [fakeEvent("A")]));
    expect(exit._tag).toBe("Failure");
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toMatch(/publisher "stuck": publishing 1 event\(s\) took longer than 50 ms/);
  });

  test("individual mode: a failure at the third of five reports that two were published (HandledPrefix)", async () => {
    const sent: Array<string> = [];
    const flaky: OutboxPublisher = {
      name: "flaky",
      preferredMode: "individual",
      publishBatch: (events) => (events[0]!.type === "C" ? Effect.fail("C refused") : Effect.sync(() => void sent.push(events[0]!.type)))
    };
    const handler = makeOutboxEventHandler([flaky]);
    const exit = await Effect.runPromiseExit(handler.handle(toKey({ topic: "orders", publisher: "flaky" }), ["A", "B", "C", "D", "E"].map(fakeEvent)));
    expect(sent).toEqual(["A", "B"]);
    const error = exit._tag === "Failure" ? (exit.cause.reasons.find(Cause.isFailReason)?.error as HandledPrefix) : undefined;
    expect(error).toBeInstanceOf(HandledPrefix);
    expect([error!.handled, error!.cause]).toEqual([2, "C refused"]);
  });

  test("individual mode: a failure at the FIRST event is that failure, with nothing to keep", async () => {
    const refusing: OutboxPublisher = { name: "refusing", preferredMode: "individual", publishBatch: () => Effect.fail("refused") };
    const exit = await Effect.runPromiseExit(makeOutboxEventHandler([refusing]).handle(toKey({ topic: "orders", publisher: "refusing" }), [fakeEvent("A"), fakeEvent("B")]));
    expect(exit._tag === "Failure" ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined).toBe("refused");
  });
});
