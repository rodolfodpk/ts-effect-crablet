import { describe, expect, test } from "bun:test";
import type { Baseline } from "./coverage-gate.ts";
import { check, measure, raise, type Report } from "./mutation-gate.ts";

const baseline: Baseline = { tolerancePoints: 0.5, overall: 85, packages: { a: 90, b: 80 } };
type Counts = Partial<Record<"Killed" | "Timeout" | "Survived" | "NoCoverage" | "Ignored" | "CompileError", number>>;
const file = (counts: Counts) => ({ mutants: Object.entries(counts).flatMap(([status, n]) => Array.from({ length: n }, () => ({ status }))) }) as Report["files"][string];
const report = (files: Record<string, Counts>): Report => ({ files: Object.fromEntries(Object.entries(files).map(([name, counts]) => [name, file(counts)])) });

describe("mutation gate", () => {
  test("the score is Stryker's: killed and timed out, over those plus survived and not covered; ignored and compile errors do not count", () => {
    const measured = measure(report({ "packages/a/src/x.ts": { Killed: 6, Timeout: 2, Survived: 1, NoCoverage: 1, Ignored: 50, CompileError: 7 } }));
    expect(measured.get("a")).toBe(80);
  });

  test("per package, and tier 1 as a whole over every mutant, not the mean of the packages", () => {
    const measured = measure(report({ "packages/a/src/x.ts": { Killed: 9, Survived: 1 }, "packages/a/src/y.ts": { Killed: 10 }, "packages/b/src/z.ts": { Killed: 0, Survived: 10 } }));
    expect(measured.get("a")).toBe(95);
    expect(measured.get("b")).toBe(0);
    expect(measured.get("(tier 1)")).toBe(63.333333333333336);
  });

  test("at or above the baseline passes, and within the tolerance too", () => {
    expect(check(measure(report({ "packages/a/src/x.ts": { Killed: 896, Survived: 104 }, "packages/b/src/y.ts": { Killed: 800, Survived: 200 } })), baseline)).toEqual([]);
  });

  test("a package below its baseline by more than the tolerance fails, by name", () => {
    const failures = check(measure(report({ "packages/a/src/x.ts": { Killed: 894, Survived: 106 }, "packages/b/src/y.ts": { Killed: 800, Survived: 200 } })), baseline);
    expect(failures).toEqual(["a: 89.4% is below its baseline 90.0% (tolerance 0.5 points)"]);
  });

  test("the whole can fail while each package passes", () => {
    const failures = check(measure(report({ "packages/a/src/x.ts": { Killed: 9, Survived: 1 }, "packages/b/src/y.ts": { Killed: 8, Survived: 2 } })), { ...baseline, overall: 99 });
    expect(failures.map((f) => f.split(":")[0])).toEqual(["(tier 1)"]);
  });

  test("a package in the baseline with no mutants measured fails, with a hint", () => {
    const failures = check(measure(report({ "packages/a/src/x.ts": { Killed: 10 } })), baseline);
    expect(failures.some((f) => f.startsWith("b: no mutants measured") && f.includes("tools/mutation/baseline.json"))).toBe(true);
  });

  test("files outside packages/ are not counted", () => {
    expect([...measure(report({ "tools/x.ts": { Survived: 10 }, "packages/a/src/x.ts": { Killed: 1 } })).keys()]).toEqual(["(tier 1)", "a"]);
  });

  test("raising never lowers a baseline, rounds down to a tenth, adds new packages, and raises the whole", () => {
    const measured = measure(report({ "packages/a/src/x.ts": { Killed: 85, Survived: 15 }, "packages/c/src/z.ts": { Killed: 977, Survived: 23 } }));
    const next = raise(measured, baseline);
    expect(next.packages).toEqual({ a: 90, b: 80, c: 97.7 });
    expect(next.overall).toBe(96.5);
  });
});
