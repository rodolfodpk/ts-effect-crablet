import { describe, expect, test } from "bun:test";
import { mergeCoverage, parseLcov, percent, toLcov, totalsOf } from "./merge-coverage.ts";

const lcov = (file: string, lines: ReadonlyArray<readonly [number, number]>): string =>
  [`SF:${file}`, ...lines.map(([n, h]) => `DA:${n},${h}`), "end_of_record"].join("\n");

describe("merge-coverage", () => {
  test("a line is covered if either suite executed it, and hits add up", () => {
    const unit = parseLcov(lcov("packages/a/src/x.ts", [[1, 1], [2, 0], [3, 0]]));
    const integration = parseLcov(lcov("packages/a/src/x.ts", [[1, 0], [2, 4], [3, 0]]));
    const merged = mergeCoverage([unit, integration]);
    expect(merged.get("packages/a/src/x.ts")).toEqual(new Map([[1, 1], [2, 4], [3, 0]]));
    expect(percent(totalsOf(merged))).toBe("66.7%");
  });

  test("files only one suite saw are kept, and absolute paths are made relative", () => {
    const a = parseLcov(lcov("/repo/packages/a/src/x.ts", [[1, 1]]), "/repo");
    const b = parseLcov(lcov("packages/b/src/y.ts", [[1, 0]]), "/repo");
    const merged = mergeCoverage([a, b]);
    expect([...merged.keys()].sort()).toEqual(["packages/a/src/x.ts", "packages/b/src/y.ts"]);
  });

  test("the written lcov reads back to the same coverage, with LF and LH", () => {
    const merged = mergeCoverage([parseLcov(lcov("packages/a/src/x.ts", [[3, 2], [1, 0]]))]);
    const text = toLcov(merged);
    expect(text).toContain("LF:2");
    expect(text).toContain("LH:1");
    expect(parseLcov(text)).toEqual(merged);
  });

  test("totals can be restricted to a set of files, and an empty set is n/a", () => {
    const merged = mergeCoverage([parseLcov(lcov("examples/e/src/x.ts", [[1, 1]]) + "\n" + lcov("packages/a/src/y.ts", [[1, 0], [2, 0]]))]);
    expect(totalsOf(merged, (f) => f.startsWith("packages/"))).toEqual({ hit: 0, total: 2 });
    expect(percent(totalsOf(merged, () => false))).toBe("n/a");
  });
});
