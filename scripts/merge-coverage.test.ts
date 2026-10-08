import { describe, expect, test } from "bun:test";
import { codeLines, isMeasured, mergeSuites, parseLcov, percent, toLcov, totalsOf } from "./merge-coverage.ts";

const lcov = (file: string, lines: ReadonlyArray<readonly [number, number]>): string =>
  [`SF:${file}`, ...lines.map(([n, h]) => `DA:${n},${h}`), "end_of_record"].join("\n");
const cov = (file: string, lines: ReadonlyArray<readonly [number, number]>) => parseLcov(lcov(file, lines), "/repo");

describe("merge-coverage", () => {
  test("a line either suite executed is covered, and hits add up", () => {
    const merged = mergeSuites(cov("packages/a/src/x.ts", [[1, 1], [2, 0], [3, 0]]), cov("packages/a/src/x.ts", [[1, 0], [2, 4], [3, 0]]));
    expect(merged.get("packages/a/src/x.ts")).toEqual(new Map([[1, 1], [2, 4], [3, 0]]));
    expect(percent(totalsOf(merged))).toBe("66.7%");
  });

  test("a line only Node reports as executed (an import, a comment) is not counted, but a line only Node reports as missed is", () => {
    const merged = mergeSuites(cov("packages/a/src/x.ts", [[5, 1]]), cov("packages/a/src/x.ts", [[1, 3], [2, 3], [5, 3], [9, 0]]));
    expect([...merged.get("packages/a/src/x.ts")!.keys()].sort((a, b) => a - b)).toEqual([5, 9]);
    expect(totalsOf(merged)).toEqual({ hit: 1, total: 2 });
  });

  test("a file Bun never loaded is judged by its code lines, taken from the source", () => {
    const source = ["import { x } from \"y\";", "// a comment", "", "export const f = () => {", "  return 1;", "};"].join("\n");
    const merged = mergeSuites(new Map(), cov("packages/a/src/x.ts", [[1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2]]), () => source);
    expect([...merged.get("packages/a/src/x.ts")!.keys()]).toEqual([4, 5]);
  });

  test("a file only the unit suite saw (an example) keeps Bun's lines", () => {
    const merged = mergeSuites(cov("examples/e/src/x.ts", [[1, 1], [2, 0]]), new Map());
    expect(totalsOf(merged)).toEqual({ hit: 1, total: 2 });
  });

  test("the written lcov reads back to the same coverage, with LF and LH", () => {
    const merged = mergeSuites(cov("packages/a/src/x.ts", [[3, 2], [1, 0]]), new Map());
    const text = toLcov(merged);
    expect(text).toContain("LF:2");
    expect(text).toContain("LH:1");
    expect(parseLcov(text, "/repo")).toEqual(merged);
  });

  test("totals can be restricted to a set of files, and an empty set is n/a", () => {
    const merged = mergeSuites(cov("examples/e/src/x.ts", [[1, 1]]), cov("packages/a/src/y.ts", [[1, 0], [2, 0]]));
    expect(totalsOf(merged, (f) => f.startsWith("packages/"))).toEqual({ hit: 0, total: 2 });
    expect(percent(totalsOf(merged, () => false))).toBe("n/a");
  });
});

describe("isMeasured", () => {
  test("test support, diagnostics, tutorial tests and scripts are left out; sources are kept", () => {
    expect(isMeasured("packages/commands/test/support/transfer.ts")).toBe(false);
    expect(isMeasured("packages/eventstore/diagnostics/storage.diagnostic.ts")).toBe(false);
    expect(isMeasured("examples/course-enrolment-app/tutorial/step1.test.ts")).toBe(false);
    expect(isMeasured("scripts/merge-coverage.ts")).toBe(false);
    expect(isMeasured("packages/eventstore/src/Leader.ts")).toBe(true);
    expect(isMeasured("examples/wallet-example-app/src/WalletApp.ts")).toBe(true);
  });
});

describe("codeLines", () => {
  test("skips blanks, comments, imports, types and lone braces; keeps statements", () => {
    const source = [
      "import { a } from \"a\";",
      "import type { B } from \"b\";",
      "",
      "/* a block",
      "   comment */",
      "// line comment",
      "export interface I { readonly x: number }",
      "export type T = string;",
      "export const f = (n: number) => {",
      "  if (n > 0) {",
      "    return n;",
      "  }",
      "  return 0;",
      "};"
    ].join("\n");
    expect([...codeLines(source)]).toEqual([9, 10, 11, 13]);
  });
});
