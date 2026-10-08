// Merges line coverage from several lcov files (the Bun unit suite and the Node integration suite) into one: a line is covered if ANY suite executed it, and its hit count is
// the sum. Only lines (SF, DA, LF, LH) are written: function and branch records are named differently by Bun and Node, so merging them would mislead.
//
//   bun scripts/merge-coverage.ts --out coverage/lcov.info coverage/unit/lcov.info coverage/integration/lcov.info
//
// It also prints the totals, for all files and for the packages only (the number the project is judged by: docs/plans/test-coverage.md).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type LineHits = Map<number, number>;
export type Coverage = Map<string, LineHits>;

const normalize = (file: string, root: string): string => {
  const rel = path.isAbsolute(file) ? path.relative(root, file) : file;
  return rel.split(path.sep).join("/");
};

export const parseLcov = (text: string, root: string = process.cwd()): Coverage => {
  const coverage: Coverage = new Map();
  let current: LineHits | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const file = normalize(line.slice(3), root);
      current = coverage.get(file) ?? new Map();
      coverage.set(file, current);
    } else if (line.startsWith("DA:") && current !== null) {
      const [n, hits] = line.slice(3).split(",");
      const number = Number(n);
      current.set(number, (current.get(number) ?? 0) + Number(hits));
    } else if (line === "end_of_record") {
      current = null;
    }
  }
  return coverage;
};

export const mergeCoverage = (parts: ReadonlyArray<Coverage>): Coverage => {
  const merged: Coverage = new Map();
  for (const part of parts) {
    for (const [file, lines] of part) {
      const into = merged.get(file) ?? new Map<number, number>();
      for (const [n, hits] of lines) into.set(n, (into.get(n) ?? 0) + hits);
      merged.set(file, into);
    }
  }
  return merged;
};

export const toLcov = (coverage: Coverage): string =>
  [...coverage.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, lines]) => {
      const sorted = [...lines.entries()].sort(([a], [b]) => a - b);
      const hit = sorted.filter(([, h]) => h > 0).length;
      return [`SF:${file}`, ...sorted.map(([n, h]) => `DA:${n},${h}`), `LF:${sorted.length}`, `LH:${hit}`, "end_of_record"].join("\n");
    })
    .join("\n") + "\n";

export interface Totals {
  readonly hit: number;
  readonly total: number;
}

export const totalsOf = (coverage: Coverage, include: (file: string) => boolean = () => true): Totals => {
  let hit = 0;
  let total = 0;
  for (const [file, lines] of coverage) {
    if (!include(file)) continue;
    for (const hits of lines.values()) {
      total++;
      if (hits > 0) hit++;
    }
  }
  return { hit, total };
};

export const percent = ({ hit, total }: Totals): string => (total === 0 ? "n/a" : `${((100 * hit) / total).toFixed(1)}%`);

const packageOf = (file: string): string | null => {
  const m = /^packages\/([^/]+)\/src\//u.exec(file);
  return m ? m[1]! : null;
};

export const summary = (coverage: Coverage): string => {
  const packages = [...new Set([...coverage.keys()].map(packageOf).filter((p): p is string => p !== null))].sort();
  const lines = [
    `all measured files        ${percent(totalsOf(coverage))}  (${totalsOf(coverage).hit}/${totalsOf(coverage).total} lines)`,
    `packages only             ${percent(totalsOf(coverage, (f) => packageOf(f) !== null))}  (${totalsOf(coverage, (f) => packageOf(f) !== null).hit}/${totalsOf(coverage, (f) => packageOf(f) !== null).total} lines)`,
    ""
  ];
  for (const p of packages) {
    const t = totalsOf(coverage, (f) => packageOf(f) === p);
    lines.push(`  ${p.padEnd(18)} ${percent(t).padStart(6)}  ${t.hit}/${t.total}`);
  }
  return lines.join("\n");
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  if (outIndex < 0 || args[outIndex + 1] === undefined) throw new Error("usage: merge-coverage.ts --out <file> <lcov>...");
  const out = args[outIndex + 1]!;
  const inputs = args.filter((_, i) => i !== outIndex && i !== outIndex + 1);
  if (inputs.length === 0) throw new Error("no input lcov files");
  const merged = mergeCoverage(inputs.map((file) => parseLcov(readFileSync(file, "utf8"))));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, toLcov(merged));
  console.log(summary(merged));
}
