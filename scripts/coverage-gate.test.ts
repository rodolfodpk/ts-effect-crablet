import { describe, expect, test } from "bun:test";
import { check, checkFiles, measure, raise, type Baseline } from "./coverage-gate.ts";
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

  test("raising keeps the notes that explain a baseline", () => {
    const next = raise(measure(parseLcov(lcov("packages/a/src/x.ts", 100, 100), "/repo")), { ...baseline, notes: { a: "why" } });
    expect(next.notes).toEqual({ a: "why" });
  });

  test("deleting code with its tests does not trip it: percentages, not line counts", () => {
    expect(check(measured([19, 20], [8, 10]), { ...baseline, overall: 85 })).toEqual([]);
  });
});

describe("per-file floor", () => {
  const floorBaseline: Baseline = { ...baseline, fileFloor: 90, fileExclusions: {} };
  const files = (...entries: ReadonlyArray<readonly [string, number, number]>) => parseLcov(entries.map(([f, h, t]) => lcov(f, h, t)).join("\n"), "/repo");

  test("a file below the floor fails by name; a file at or above it passes", () => {
    const failures = checkFiles(files(["packages/a/src/ok.ts", 90, 100], ["packages/a/src/low.ts", 89, 100]), floorBaseline);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("packages/a/src/low.ts");
  });

  test("an excluded file may be below the floor", () => {
    const b = { ...floorBaseline, fileExclusions: { "packages/a/src/low.ts": "defensive branches that need a fake database" } };
    expect(checkFiles(files(["packages/a/src/low.ts", 10, 100]), b)).toEqual([]);
  });

  test("a stale exclusion fails: the file is above the floor now, or is not measured any more", () => {
    const b = { ...floorBaseline, fileExclusions: { "packages/a/src/was-low.ts": "old reason", "packages/a/src/gone.ts": "old reason" } };
    const failures = checkFiles(files(["packages/a/src/was-low.ts", 99, 100]), b);
    expect(failures.some((f) => f.includes("was-low.ts") && f.includes("stale"))).toBe(true);
    expect(failures.some((f) => f.includes("gone.ts") && f.includes("no longer measured"))).toBe(true);
  });

  test("no floor in the baseline means no per-file check; examples are not checked", () => {
    expect(checkFiles(files(["packages/a/src/low.ts", 1, 100]), baseline)).toEqual([]);
    expect(checkFiles(files(["examples/e/src/low.ts", 1, 100]), floorBaseline)).toEqual([]);
  });

  test("raising keeps the floor and the exclusions", () => {
    const next = raise(measure(parseLcov(lcov("packages/a/src/x.ts", 100, 100), "/repo")), { ...floorBaseline, fileExclusions: { "packages/a/src/y.ts": "why" } });
    expect(next.fileFloor).toBe(90);
    expect(next.fileExclusions).toEqual({ "packages/a/src/y.ts": "why" });
  });
});
