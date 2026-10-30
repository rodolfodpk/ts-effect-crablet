import { describe, expect, test } from "bun:test";
import * as Tag from "../src/Tag.ts";
import * as TagCodec from "../src/TagCodec.ts";

// How a tag is stored (ADR-0049): any key and any value make the round trip; a key without `%` or `=` (every key written before) is stored unchanged.
describe("TagCodec", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [["a=b", "c"], ["50%", "v"], ["%3D", "w"], ["%253D", "w"], ["a=b=c", "x"], ["product:123", "y"], ["k", "x=y"], ["", "v"], ["k", ""], ["=", "="]];

  test("every key and value makes the round trip, and the first `=` of the stored text is the separator", () => {
    for (const [key, value] of cases) {
      const stored = TagCodec.encode({ key, value });
      expect(TagCodec.decode(stored)).toEqual({ key, value });
      expect(stored.slice(stored.indexOf("=") + 1)).toBe(value);
    }
  });

  test("a key with neither `%` nor `=` is stored as it is", () => {
    expect(TagCodec.encode({ key: "wallet_id", value: "w-1" })).toBe("wallet_id=w-1");
    expect(TagCodec.encodeKey("product:123")).toBe("product:123");
  });

  test("two different tags never share a stored text", () => {
    expect(TagCodec.encode({ key: "a=b", value: "c" })).not.toBe(TagCodec.encode({ key: "a", value: "b=c" }));
  });

  test("decoding keeps any `%` that is not %25 or %3D, and reads a text with no `=` as a key with an empty value", () => {
    expect(TagCodec.decodeKey("100%off%2F")).toBe("100%off%2F");
    expect(TagCodec.decode("bare")).toEqual({ key: "bare", value: "" });
  });
});

describe("Tag.distinct", () => {
  test("keeps each tag once, in the order it first appears; the same key with other values stays", () => {
    const k1 = Tag.of("k", "1"), k2 = Tag.of("k", "2");
    expect(Tag.distinct([k1, k2, Tag.of("k", "1"), k2])).toEqual([k1, k2]);
    expect(Tag.distinct([])).toEqual([]);
  });
});
