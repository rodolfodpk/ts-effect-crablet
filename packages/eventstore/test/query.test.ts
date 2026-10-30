import { describe, expect, test } from "bun:test";
import * as Query from "../src/Query.ts";
import { queryMatches } from "../src/spec/Spec.ts";

const event = (type: string, tags: ReadonlyArray<readonly [string, string]> = []) => ({ type, position: 1n, tags: tags.map(([key, value]) => ({ key, value })) });
const t = { key: "k", value: "1" };

describe("Query: the query builders", () => {
  test("of takes one item or a list of them", () => {
    const item = Query.queryItemOfType("A");
    expect(Query.of(item)).toEqual({ items: [item] });
    expect(Query.of([item, item])).toEqual({ items: [item, item] });
  });

  test("forEventAndTag matches its type with its tag only, and lower-cases the key", () => {
    const q = Query.forEventAndTag("A", "Op", "1");
    expect(q).toEqual({ items: [{ eventTypes: ["A"], tags: [{ key: "op", value: "1" }] }] });
    expect(queryMatches(q, event("A", [["op", "1"]]))).toBe(true);
    expect(queryMatches(q, event("A", [["op", "2"]]))).toBe(false);
    expect(queryMatches(q, event("A"))).toBe(false);
  });

  test("forEventAndTags and forEventsAndTags keep the tags they are given", () => {
    expect(Query.forEventAndTags("A", [t])).toEqual({ items: [{ eventTypes: ["A"], tags: [t] }] });
    expect(Query.forEventsAndTags(["A", "B"], [t])).toEqual({ items: [{ eventTypes: ["A", "B"], tags: [t] }] });
    expect(Query.forEvent("A")).toEqual({ items: [{ eventTypes: ["A"], tags: [] }] });
  });

  test("noCondition has no items; isEmpty tells a query with none", () => {
    expect(Query.noCondition()).toEqual({ items: [] });
    expect(Query.isEmpty(Query.noCondition())).toBe(true);
    expect(Query.isEmpty(Query.forEvent("A"))).toBe(false);
  });
});

describe("Query: an item targets events by type and/or tags (ADR-0049)", () => {
  test("an item with neither is refused; one with only types or only tags is not", () => {
    expect(() => Query.queryItemOf([], [])).toThrow(/targets events by type and\/or tags/);
    expect(() => Query.forEventsAndTags([], [])).toThrow(/targets events by type and\/or tags/);
    expect(Query.queryItemOf(["A"], [])).toEqual({ eventTypes: ["A"], tags: [] });
    expect(Query.queryItemOf([], [t])).toEqual({ eventTypes: [], tags: [t] });
  });

  test("emptyItemIn names the problem of a query with such an item, built without queryItemOf", () => {
    expect(Query.emptyItemIn(Query.of([{ eventTypes: [], tags: [] }]))).toMatch(/targets events by type and\/or tags/);
    expect(Query.emptyItemIn(Query.of([Query.queryItemOfType("A"), { eventTypes: [], tags: [] }]))).not.toBeNull();
    expect(Query.emptyItemIn(Query.forEvent("A"))).toBeNull();
    expect(Query.emptyItemIn(Query.noCondition())).toBeNull();
  });
});

describe("Query.all: every event (ADR-0050)", () => {
  test("is its own variant: not empty, matches every event, and survives a union", () => {
    expect(Query.isAll(Query.all())).toBe(true);
    expect(Query.isEmpty(Query.all())).toBe(false);
    expect(Query.isEmpty(Query.noCondition())).toBe(true);
    expect(queryMatches(Query.all(), event("Anything", [["k", "1"]]))).toBe(true);
    expect(Query.isAll(Query.union(Query.forEvent("A"), Query.all()))).toBe(true);
    expect(Query.union(Query.forEvent("A"), Query.forEvent("B"))).toEqual(Query.of([Query.queryItemOfType("A"), Query.queryItemOfType("B")]));
    expect(Query.union()).toEqual(Query.noCondition());
  });
});

