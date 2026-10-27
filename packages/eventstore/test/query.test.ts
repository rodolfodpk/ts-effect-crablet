import { describe, expect, test } from "bun:test";
import * as Query from "../src/Query.ts";
import { queryMatches } from "../src/spec/Spec.ts";

const event = (type: string, tags: ReadonlyArray<readonly [string, string]> = []) => ({ type, position: 1n, tags: tags.map(([key, value]) => ({ key, value })) });
const t = { key: "k", value: "1" };

describe("Query: the item builders", () => {
  test("each builds the item it names, with nothing else in it", () => {
    expect(Query.queryItemOfTypes(["A", "B"])).toEqual({ eventTypes: ["A", "B"], tags: [] });
    expect(Query.queryItemOfTags([t])).toEqual({ eventTypes: [], tags: [t] });
    expect(Query.queryItemOfType("A")).toEqual({ eventTypes: ["A"], tags: [] });
    expect(Query.queryItemOfTag(t)).toEqual({ eventTypes: [], tags: [t] });
  });
});

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

  test("empty and noCondition have no items; isEmpty tells a query with none", () => {
    expect(Query.empty()).toEqual({ items: [] });
    expect(Query.noCondition()).toEqual({ items: [] });
    expect(Query.isEmpty(Query.empty())).toBe(true);
    expect(Query.isEmpty(Query.forEvent("A"))).toBe(false);
  });
});
