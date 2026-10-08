import { describe, expect, test } from "bun:test";
import * as Tag from "../src/Tag.ts";

describe("Tag", () => {
  test("keys are lower-cased and values are kept exactly", () => {
    expect(Tag.of("Wallet_ID", "W-1")).toEqual({ key: "wallet_id", value: "W-1" });
  });

  test("ofPairs reads alternating keys and values", () => {
    expect(Tag.ofPairs("a", "1", "B", "2")).toEqual([{ key: "a", value: "1" }, { key: "b", value: "2" }]);
    expect(Tag.ofPairs()).toEqual([]);
  });

  test("ofPairs refuses an odd number of arguments rather than dropping one silently", () => {
    expect(() => Tag.ofPairs("a", "1", "b")).toThrow("Key-value pairs must be even");
  });
});
