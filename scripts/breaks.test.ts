// The list of tier 2 breaks (scripts/breaks.ts) is checked on every unit run, without Docker: a change that moves the code a break names makes this fail at once,
// not at the next run of the breaks.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { breaks, stale } from "./breaks.ts";

describe("the tier 2 breaks", () => {
  test("each break's text is in its file exactly once, and it changes it", () => {
    expect(stale(breaks, (file) => readFileSync(file, "utf8"))).toEqual([]);
    for (const b of breaks) expect(b.replace).not.toBe(b.find);
  });

  test("each names integration tests that exist, a reason, and an id of its own", () => {
    for (const b of breaks) {
      expect(b.tests.length).toBeGreaterThan(0);
      for (const t of b.tests) expect(existsSync(t) && t.includes("/test/integration/")).toBe(true);
      expect(b.why.length).toBeGreaterThan(0);
    }
    expect(new Set(breaks.map((b) => b.id)).size).toBe(breaks.length);
  });

  test("a text that is gone, or that occurs twice, is reported by id", () => {
    const b = breaks[0]!;
    expect(stale([b], () => "")).toEqual([`${b.id}: its text occurs 0 times in ${b.file}, not once`]);
    expect(stale([b], () => b.find + b.find)).toEqual([`${b.id}: its text occurs 2 times in ${b.file}, not once`]);
  });
});
