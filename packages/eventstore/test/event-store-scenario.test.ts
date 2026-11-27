// Given/When/Then for direct use of the event store (EventStoreScenario), on the guide's own code (support/direct-use.ts).
import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";
import * as AppendEvent from "../src/AppendEvent.ts";
import { append } from "../src/EventStore.ts";
import { givenEvents } from "../src/testing/EventStoreScenario.ts";
import { CopyNotAvailable, lendCopy, lendTwo } from "./support/direct-use.ts";

// #region given-when-then
const lent = (copyId: string, memberId: string) => AppendEvent.make("CopyLent", { copyId, memberId }, { copy_id: copyId, member_id: memberId });

test("a copy that is out cannot be lent again: the code fails with its own error and appends nothing", async () => {
  const result = await givenEvents(lent("c-1", "m-1")).when(lendCopy("c-1", "m-2"));
  expect(result.outcome).toBe("failed");
  if (result.outcome === "failed") expect(result.error).toBeInstanceOf(CopyNotAvailable);
  expect(result.events).toEqual([]);
});

test("a copy on the shelf is lent: the event appended is the loan", async () => {
  const result = await givenEvents().when(lendCopy("c-1", "m-1"));
  expect(result.outcome).toBe("succeeded");
  expect(result.events.map((e) => [e.type, e.data])).toEqual([["CopyLent", { copyId: "c-1", memberId: "m-1" }]]);
});
// #endregion given-when-then

describe("givenEvents", () => {
  test("a transaction that fails appends nothing; later whens see earlier ones' effects", async () => {
    const s = givenEvents(lent("a", "m"));
    const both = await s.when(lendTwo("b", "a", "m"));
    expect(both.outcome).toBe("failed");
    expect(both.events).toEqual([]);
    expect((await s.when(lendCopy("b", "m"))).outcome).toBe("succeeded");
    expect((await s.when(lendCopy("b", "m"))).outcome).toBe("failed");
    expect(s.log.map((e) => e.data)).toEqual([{ copyId: "a", memberId: "m" }, { copyId: "b", memberId: "m" }]);
  });

  test("with no transaction, what was appended before the failure stays, as on Postgres, and the result shows it", async () => {
    const partial = Effect.andThen(append([lent("x", "m")]), Effect.fail("stopped" as const));
    const result = await givenEvents().when(partial);
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.error).toBe("stopped");
    expect(result.events.map((e) => e.type)).toEqual(["CopyLent"]);
  });

  test("the value the code returns is the result's", async () => {
    const result = await givenEvents(lent("a", "m")).when(Effect.succeed(42));
    expect(result).toEqual({ outcome: "succeeded", value: 42, events: [] });
  });

  test("`at` fixes the clock: the appended events occurred then", async () => {
    const now = DateTime.makeUnsafe("2026-11-27T12:00:00Z");
    const result = await givenEvents().at(now).when(lendCopy("c-1", "m-1"));
    expect(result.events[0]!.occurredAt).toEqual(DateTime.toDateUtc(now));
  });

  test("a defect is not a result: it fails the test", async () => {
    await expect(givenEvents().when(Effect.die(new Error("boom")))).rejects.toThrow(/died.*boom/su);
  });
});
