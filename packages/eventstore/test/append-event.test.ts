import { describe, expect, test } from "bun:test";
import * as AppendEvent from "../src/AppendEvent.ts";

describe("AppendEvent", () => {
  test("the builder lower-cases tag keys, skips a missing tag value and keeps the data", () => {
    const event = AppendEvent.builder("Paid").tag("Account_ID", "a1").tag("note", null).tag("other", undefined).tag("n", 3).data({ amount: 1 }).build();
    expect(event).toEqual({ type: "Paid", tags: [{ key: "account_id", value: "a1" }, { key: "n", value: "3" }], eventData: { amount: 1 } });
  });

  test("an event with no data is refused, null or never set", () => {
    expect(() => AppendEvent.builder("Paid").data(null).build()).toThrow("Event data cannot be null");
    expect(() => AppendEvent.builder("Paid").build()).toThrow("Event data cannot be null");
    expect(AppendEvent.builder("Paid").data(0).build().eventData).toBe(0);
  });

  test("hasTag: the key in any case, and the exact value", () => {
    const event = AppendEvent.of("Paid", "account_id", "a1", {});
    expect(AppendEvent.hasTag(event, "Account_ID", "a1")).toBe(true);
    expect(AppendEvent.hasTag(event, "account_id", "a2")).toBe(false);
    expect(AppendEvent.hasTag(event, "wallet_id", "a1")).toBe(false);
    expect(AppendEvent.hasTag(AppendEvent.ofUntagged("Paid", {}), "account_id", "a1")).toBe(false);
  });
});
