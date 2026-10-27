import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as CorrelationContext from "../src/CorrelationContext.ts";

describe("CorrelationContext", () => {
  test("a fresh transaction is required only inside requireFreshTransaction", async () => {
    expect(await Effect.runPromise(CorrelationContext.requiresFreshTransaction)).toBe(false);
    expect(await Effect.runPromise(CorrelationContext.requireFreshTransaction(CorrelationContext.requiresFreshTransaction))).toBe(true);
  });

  test("each id is null until set, and set only inside its effect", async () => {
    const read = Effect.all([CorrelationContext.correlationId, CorrelationContext.causationId, CorrelationContext.requestFingerprint]);
    expect(await Effect.runPromise(read)).toEqual([null, null, null]);
    const set = CorrelationContext.withCorrelationId("c1")(CorrelationContext.withCausationId(4n)(CorrelationContext.withRequestFingerprint("fp")(read)));
    expect(await Effect.runPromise(set)).toEqual(["c1", 4n, "fp"]);
  });
});
