import { describe, expect, test } from "bun:test";
import { fromKey, toKey } from "../src/TopicPublisherPair.ts";

describe("TopicPublisherPair.toKey/fromKey", () => {
  test("round-trips a plain pair", () => {
    const pair = { topic: "orders", publisher: "kafka" };
    expect(fromKey(toKey(pair))).toEqual(pair);
  });

  test("round-trips values containing the naive '::' separator unambiguously", () => {
    const pair = { topic: "orders::special", publisher: "kafka::main" };
    expect(fromKey(toKey(pair))).toEqual(pair);
  });

  test("two different pairs never produce the same key", () => {
    const keyA = toKey({ topic: "a::b", publisher: "c" });
    const keyB = toKey({ topic: "a", publisher: "b::c" });
    expect(keyA).not.toBe(keyB);
  });

  test("fromKey throws on malformed input", () => {
    expect(() => fromKey("not json")).toThrow();
    expect(() => fromKey(JSON.stringify(["only-one"]))).toThrow();
    expect(() => fromKey(JSON.stringify([1, 2]))).toThrow();
    expect(() => fromKey(JSON.stringify({ topic: "a", publisher: "b" }))).toThrow();
  });
});
