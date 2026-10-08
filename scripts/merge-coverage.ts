// Merges line coverage from the Bun unit suite and the Node integration suite into one lcov file, with one definition of "an executable line", so the number is the same
// locally and on Codecov (docs/plans/test-coverage.md).
//
//   bun scripts/merge-coverage.ts --unit coverage/unit/lcov.info --integration coverage/integration/lcov.info --out coverage/lcov.info
//
// Why not just add the two reports: Node (V8) reports whole ranges, so it marks nearly every line of a function that ran as covered, including imports, comments, blank lines and
// signatures. Adding that to Bun's statement-level report would inflate the percentage. So:
//
//   - A line is EXECUTABLE if Bun reports it (Bun reports statements), or if Node reports it as NOT executed (a miss is a miss). A line only Node reports, as executed, is not counted.
//   - A file Bun never loaded has no statement report; for it, Node's lines are filtered to those that look like code (not blank, not a comment, not a lone brace or an import or type line).
//   - A line is COVERED if either suite executed it. Hit counts add up.
//   - Only lines are written (SF, DA, LF, LH): function and branch records are named differently by the two tools, so merging them would mislead.
//
// The known imprecision: a comment inside a block Node reports as not executed counts as a miss, and a file Bun never loaded is judged by a heuristic. Both are small
// (a few lines in about a hundred files); the aim is a stable, honest number to ratchet on, not an exact one.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// The lines of a TypeScript source that can execute: not blank, not inside or starting a comment, not a lone closing brace, not an import or export-from, not an interface or type.
export const codeLines = (source: string): Set<number> => {
  const out = new Set<number>();
  let inBlockComment = false;
  source.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      return;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlockComment = true;
      return;
    }
    if (line === "" || line.startsWith("//")) return;
    if (/^[)\]}]+[;,]?\)*;?$/u.test(line) || line === "{" || line === "});") return;
    if (/^(import|export)\b[^=]*\bfrom\b/u.test(line) || /^import\s+["']/u.test(line)) return;
    if (/^(export\s+)?(interface|type)\s/u.test(line)) return;
    out.add(index + 1);
  });
  return out;
};

// Test code, diagnostics, tutorial tests and scripts are not what coverage is about (Node's include pattern lets some of them through).
export const isMeasured = (file: string): boolean => !/(^|\/)(test|diagnostics|tutorial|scripts)\//u.test(file);

export const mergeSuites = (unit: Coverage, integration: Coverage, readSource: (file: string) => string | null = () => null): Coverage => {
  const merged: Coverage = new Map();
  for (const file of new Set([...unit.keys(), ...integration.keys()])) {
    if (!isMeasured(file)) continue;
    const a = unit.get(file);
    const b = integration.get(file);
    let executable: Set<number>;
    if (a !== undefined) {
      executable = new Set(a.keys());
      for (const [n, hits] of b ?? []) if (hits === 0) executable.add(n);
    } else {
      const source = readSource(file);
      const code = source === null ? null : codeLines(source);
      executable = new Set([...(b ?? new Map<number, number>())].filter(([n, hits]) => hits === 0 || code === null || code.has(n)).map(([n]) => n));
    }
    const lines: LineHits = new Map();
    for (const n of executable) lines.set(n, (a?.get(n) ?? 0) + (b?.get(n) ?? 0));
    merged.set(file, lines);
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

export const packageOf = (file: string): string | null => /^packages\/([^/]+)\/src\//u.exec(file)?.[1] ?? null;

export const summary = (coverage: Coverage): string => {
  const packages = [...new Set([...coverage.keys()].map(packageOf).filter((p): p is string => p !== null))].sort();
  const pkgs = totalsOf(coverage, (f) => packageOf(f) !== null);
  const examples = totalsOf(coverage, (f) => packageOf(f) === null);
  const lines = [
    `packages (the number we are judged by, and gated on)  ${percent(pkgs).padStart(6)}  ${pkgs.hit}/${pkgs.total} lines`,
    `examples (unit tests only; reported, not gated)       ${percent(examples).padStart(6)}  ${examples.hit}/${examples.total} lines`,
    ""
  ];
  for (const p of packages) {
    const t = totalsOf(coverage, (f) => packageOf(f) === p);
    lines.push(`  ${p.padEnd(18)} ${percent(t).padStart(6)}  ${t.hit}/${t.total}`);
  }
  return lines.join("\n");
};

if (import.meta.main) {
  const arg = (name: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    const value = i >= 0 ? process.argv[i + 1] : undefined;
    if (value === undefined) throw new Error(`usage: merge-coverage.ts --unit <lcov> --integration <lcov> --out <lcov> (missing --${name})`);
    return value;
  };
  const read = (file: string): Coverage => parseLcov(readFileSync(file, "utf8"));
  const merged = mergeSuites(read(arg("unit")), read(arg("integration")), (file) => (existsSync(file) ? readFileSync(file, "utf8") : null));
  const out = arg("out");
  mkdirSync(path.dirname(out), { recursive: true });
  // what is uploaded and gated is the packages only; the examples are demonstration code (docs/plans/test-coverage.md, step 2)
  writeFileSync(out, toLcov(new Map([...merged].filter(([file]) => packageOf(file) !== null))));
  console.log(summary(merged));
}
