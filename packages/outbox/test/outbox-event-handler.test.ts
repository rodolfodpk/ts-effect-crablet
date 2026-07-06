import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import { makeOutboxEventHandler } from "../src/internal/OutboxEventHandler.ts";
import { toKey } from "../src/TopicPublisherPair.ts";
import type { OutboxPublisher } from "../src/OutboxPublisher.ts";

const fakeEvent = (type: string): StoredEvent => ({
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
