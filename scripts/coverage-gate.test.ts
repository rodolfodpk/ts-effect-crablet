import { describe, expect, test } from "bun:test";
import { check, measure, raise, type Baseline } from "./coverage-gate.ts";
import { parseLcov } from "./merge-coverage.ts";

const baseline: Baseline = { tolerancePoints: 0.3, overall: 85, packages: { a: 95, b: 80 } };
const lcov = (file: string, hit: number, total: number): string =>
  [`SF:${file}`, ...Array.from({ length: total }, (_, i) => `DA:${i + 1},${i < hit ? 1 : 0}`), "end_of_record"].join("\n");
const measured = (a: [number, number], b: [number, number]) =>
  measure(parseLcov([lcov("packages/a/src/x.ts", ...a), lcov("packages/b/src/y.ts", ...b)].join("\n"), "/repo"));

describe("coverage gate", () => {
  test("at or above the baseline passes", () => {
    expect(check(measured([96, 100], [80, 100]), baseline)).toEqual([]);
  });

  test("a package below its baseline fails, by name", () => {
    const failures = check(measured([90, 100], [80, 100]), baseline);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((f) => f.startsWith("a: 90.0%"))).toBe(true);
  });

  test("within the tolerance passes: the gate does not flap on a line a racy test sometimes misses", () => {
    expect(check(measured([950, 1000], [799, 1000]), { ...baseline, overall: 87 })).toEqual([]);
  });

  test("the whole can fail while each package passes", () => {
    expect(check(measured([95, 100], [80, 100]), { ...baseline, overall: 99 }).some((f) => f.startsWith("(all packages)"))).toBe(true);
  });

  test("a package in the baseline with no coverage measured fails, with a hint", () => {
    const failures = check(measure(parseLcov(lcov("packages/a/src/x.ts", 100, 100), "/repo")), baseline);
    expect(failures.some((f) => f.startsWith("b: no coverage measured"))).toBe(true);
  });

  test("raising never lowers a baseline, rounds down to a tenth, and adds new packages", () => {
    const next = raise(measure(parseLcov([lcov("packages/a/src/x.ts", 90, 100), lcov("packages/c/src/z.ts", 977, 1000)].join("\n"), "/repo")), baseline);
    expect(next.packages["a"]).toBe(95);
    expect(next.packages["b"]).toBe(80);
    expect(next.packages["c"]).toBe(97.7);
    expect(next.overall).toBe(97);
  });

  test("deleting code with its tests does not trip it: percentages, not line counts", () => {
    expect(check(measured([19, 20], [8, 10]), { ...baseline, overall: 85 })).toEqual([]);
  });
});
