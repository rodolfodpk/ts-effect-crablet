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

  test("of and ofUntagged: one tag, or none", () => {
    expect(AppendEvent.of("Paid", "Account_ID", "a1", {}).tags).toEqual([{ key: "account_id", value: "a1" }]);
    expect(AppendEvent.ofUntagged("Paid", {}).tags).toEqual([]);
  });
});
