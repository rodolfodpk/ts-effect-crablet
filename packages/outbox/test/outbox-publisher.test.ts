import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import { makeLogPublisher } from "../src/OutboxPublisher.ts";

const event = (position: bigint, eventId: string) =>
  ({ type: "DepositMade", data: {}, tags: [], position, transactionId: "7", occurredAt: new Date(0), correlationId: null, causationId: null, eventId }) as unknown as StoredEvent;

describe("makeLogPublisher", () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  afterEach(() => log.mockClear());

  test("logs each event with its place in the log and its stable id, the id a real destination would deduplicate by", async () => {
    const publisher = makeLogPublisher("audit");
    expect(publisher.name).toBe("audit");
    await Effect.runPromise(publisher.publishBatch([event(1n, "id-1"), event(2n, "id-2")]));
    expect(log.mock.calls.map((c) => c[0])).toEqual(["[audit] DepositMade @ (7, 1) id id-1", "[audit] DepositMade @ (7, 2) id id-2"]);
  });

  test("is named LogPublisher by default", () => {
    expect(makeLogPublisher().name).toBe("LogPublisher");
  });
});
