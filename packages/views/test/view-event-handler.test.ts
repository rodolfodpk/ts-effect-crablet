import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import { makeViewEventHandler } from "../src/internal/ViewEventHandler.ts";
import type { ViewProjector } from "../src/ViewProjector.ts";

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

describe("makeViewEventHandler", () => {
  test("routes to the projector matching the given viewName", async () => {
    const seenA: Array<StoredEvent> = [];
    const seenB: Array<StoredEvent> = [];
    const handler = makeViewEventHandler([
      fakeProjector("view-a", (events) => seenA.push(...events)),
      fakeProjector("view-b", (events) => seenB.push(...events))
    ]);

    const events = [fakeEvent("SomeEvent")];
    const handled = await Effect.runPromise(handler.handle("view-b", events));

    expect(handled).toBe(1);
    expect(seenA).toEqual([]);
    expect(seenB).toEqual(events);
  });

  test("dies on an unregistered view name", async () => {
    const handler = makeViewEventHandler([fakeProjector("view-a", () => {})]);
    await expect(Effect.runPromise(handler.handle("unknown-view", []))).rejects.toThrow();
  });
});
