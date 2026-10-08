import { describe, expect, test } from "bun:test";
import * as EventSelection from "../src/EventSelection.ts";

describe("EventSelection", () => {
  test("empty selects nothing in particular, and of() overrides only what it is given", () => {
    const empty = EventSelection.empty();
    expect(empty.eventTypes.size + empty.requiredTags.size + empty.anyOfTags.size + empty.exactTags.size).toBe(0);
    const selection = EventSelection.of({ eventTypes: new Set(["A"]), exactTags: new Map([["k", "v"]]) });
    expect([...selection.eventTypes]).toEqual(["A"]);
    expect([...selection.exactTags]).toEqual([["k", "v"]]);
    expect(selection.requiredTags.size).toBe(0);
  });

  test("the unions combine what several subscribers ask for, without duplicates: this is what the shared wake-up filter is built from", () => {
    const a = EventSelection.of({ eventTypes: new Set(["A", "B"]), requiredTags: new Set(["wallet_id"]), anyOfTags: new Set(["x"]), exactTags: new Map([["k1", "v"]]) });
    const b = EventSelection.of({ eventTypes: new Set(["B", "C"]), requiredTags: new Set(["wallet_id", "deposit_id"]), anyOfTags: new Set(["y"]), exactTags: new Map([["k2", "v"]]) });
    expect([...EventSelection.unionEventTypes([a, b])].sort()).toEqual(["A", "B", "C"]);
    expect([...EventSelection.unionRequiredTags([a, b])].sort()).toEqual(["deposit_id", "wallet_id"]);
    expect([...EventSelection.unionAnyOfTags([a, b])].sort()).toEqual(["x", "y"]);
    expect([...EventSelection.unionExactTagKeys([a, b])].sort()).toEqual(["k1", "k2"]);
    expect(EventSelection.unionEventTypes([]).size).toBe(0);
  });
});
