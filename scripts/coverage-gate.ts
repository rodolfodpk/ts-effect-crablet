// The coverage gate (docs/history/plans/test-coverage.md, steps 3 and 5). It compares the merged report (coverage/lcov.info, packages only) with the
// committed baselines and fails when
//   - a package, or the packages as a whole, falls below its baseline by more than the tolerance (the ratchet: coverage may not go down), or
//   - a source file is below the per-file floor and is not listed in `fileExclusions` with a reason, or
//   - an exclusion is stale (the file is gone, or is above the floor now): the list of exceptions cannot grow silently and cannot outlive its reason.
//
//   bun scripts/coverage-gate.ts                 # check: exit 1 on a regression
//   bun scripts/coverage-gate.ts --update        # raise the baseline to the current numbers (it never lowers one)
//
// The tolerance (a few tenths of a percentage point) absorbs run-to-run differences such as a line a racy test only sometimes reaches. Percentages, not line counts, so deleting code
// together with its tests does not trip the gate. Lowering a baseline is done by editing it by hand, with the reason in the commit message.
//
// Where the baselines are: each package records its own in its package.json, `crablet.coverage: { lines, note?, fileExclusions? }` (a package
// changes it for its own reasons, like `crablet.typeEscapes`). `coverage-baseline.json` holds only the repository's policy: the tolerance, the
// per-file floor and the floor of the packages as a whole.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { packageOf, parseLcov, percent, totalsOf, type Coverage } from "./merge-coverage.ts";

export interface Baseline {
  readonly notes?: Readonly<Record<string, string>>;
  // no file may be below this percentage, unless listed in fileExclusions (file -> the reason)
  readonly fileFloor?: number;
  readonly fileExclusions?: Readonly<Record<string, string>>;
  readonly tolerancePoints: number;
  readonly overall: number;
  readonly packages: Readonly<Record<string, number>>;
}

export type Measured = ReadonlyMap<string, number>;

const floor1 = (value: number): number => Math.floor(value * 10) / 10;

// package name -> line coverage in percent, and the key "(all packages)" for the whole
export const measure = (coverage: Coverage): Measured => {
  const names = [...new Set([...coverage.keys()].map(packageOf).filter((p): p is string => p !== null))].sort();
  const out = new Map<string, number>();
  for (const name of names) {
    const t = totalsOf(coverage, (f) => packageOf(f) === name);
    if (t.total > 0) out.set(name, (100 * t.hit) / t.total);
  }
  const all = totalsOf(coverage, (f) => packageOf(f) !== null);
  out.set("(all packages)", all.total === 0 ? 0 : (100 * all.hit) / all.total);
  return out;
};

export const check = (measured: Measured, baseline: Baseline): ReadonlyArray<string> => {
  const failures: Array<string> = [];
  const expect = (name: string, floor: number): void => {
    const now = measured.get(name);
    if (now === undefined) failures.push(`${name}: no coverage measured (baseline ${floor.toFixed(1)}%). Was the package removed? Then remove its crablet.coverage from its package.json.`);
    else if (now < floor - baseline.tolerancePoints) failures.push(`${name}: ${now.toFixed(1)}% is below its baseline ${floor.toFixed(1)}% (tolerance ${baseline.tolerancePoints} points)`);
  };
  expect("(all packages)", baseline.overall);
  for (const [name, floor] of Object.entries(baseline.packages)) expect(name, floor);
  return failures;
};

export const checkFiles = (coverage: Coverage, baseline: Baseline): ReadonlyArray<string> => {
  const floor = baseline.fileFloor;
  if (floor === undefined) return [];
  const exclusions = baseline.fileExclusions ?? {};
  const failures: Array<string> = [];
  const seen = new Set<string>();
  for (const [file, lines] of coverage) {
    if (packageOf(file) === null) continue;
    seen.add(file);
    const t = totalsOf(new Map([[file, lines]]));
    const now = t.total === 0 ? 100 : (100 * t.hit) / t.total;
    const excluded = file in exclusions;
    if (now < floor && !excluded) failures.push(`${file}: ${now.toFixed(1)}% is below the per-file floor of ${floor}% (add tests, or list it in its package's crablet.coverage.fileExclusions with the reason)`);
    if (now >= floor && excluded) failures.push(`${file}: ${now.toFixed(1)}% is above the floor now, so its exclusion is stale; remove it from crablet.coverage.fileExclusions`);
  }
  for (const file of Object.keys(exclusions)) if (!seen.has(file)) failures.push(`${file}: excluded in crablet.coverage.fileExclusions but no longer measured; remove the entry`);
  return failures;
};

// A new baseline: every number is the larger of the old and the current (rounded down to a tenth), and packages that are new are added.
export const raise = (measured: Measured, baseline: Baseline): Baseline => {
  const packages: Record<string, number> = { ...baseline.packages };
  for (const [name, now] of measured) {
    if (name === "(all packages)") continue;
    packages[name] = Math.max(packages[name] ?? 0, floor1(now));
  }
  const sorted = Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b)));
  return { ...baseline, overall: Math.max(baseline.overall, floor1(measured.get("(all packages)") ?? 0)), packages: sorted };
};

// What a package records in its package.json.
export interface PackageCoverage {
  readonly lines: number;
  readonly note?: string;
  // file (repository path) -> why it may be below the per-file floor
  readonly fileExclusions?: Readonly<Record<string, string>>;
}

// The repository's policy, in coverage-baseline.json.
export interface Policy {
  readonly tolerancePoints: number;
  readonly fileFloor?: number;
  readonly overall: number;
}

// The baseline the checks take, put together from the policy and each package's own record.
export const assemble = (policy: Policy, packages: ReadonlyMap<string, PackageCoverage>): Baseline => {
  const lines: Record<string, number> = {};
  const notes: Record<string, string> = {};
  const fileExclusions: Record<string, string> = {};
  for (const [name, c] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    lines[name] = c.lines;
    if (c.note !== undefined) notes[name] = c.note;
    Object.assign(fileExclusions, c.fileExclusions ?? {});
  }
  return { ...policy, fileExclusions, packages: lines, notes };
};

// The package.json text with `crablet.coverage.lines` set to `lines`, everything else left as it is written.
export const withLines = (text: string, lines: number): string => {
  const value = String(lines);
  if (/"coverage":\s*\{\s*"lines":\s*[0-9.]+/u.test(text)) return text.replace(/("coverage":\s*\{\s*"lines":\s*)[0-9.]+/u, `$1${value}`);
  const entry = `"coverage": { "lines": ${value} }`;
  if (/"crablet":\s*\{/u.test(text)) return text.replace(/"crablet":\s*\{(\s*)/u, (_m, space: string) => `"crablet": {${space}${entry},${space}`);
  return text.replace(/\n\}\s*$/u, `,\n  "crablet": { ${entry} }\n}\n`);
};

const packageJsonOf = (root: string, name: string): string => path.join(root, "packages", name, "package.json");

// Each package's record, from packages/*/package.json; a package with none is not in the map (the gate then has no floor for it).
export const readPackages = (root: string): ReadonlyMap<string, PackageCoverage> =>
  new Map(
    readdirSync(path.join(root, "packages"))
      .filter((name) => existsSync(packageJsonOf(root, name)))
      .flatMap((name) => {
        const recorded = (JSON.parse(readFileSync(packageJsonOf(root, name), "utf8")) as { crablet?: { coverage?: PackageCoverage } }).crablet?.coverage;
        return recorded === undefined ? [] : [[name, recorded] as const];
      })
  );

if (import.meta.main) {
  const policyFile = "coverage-baseline.json";
  const coverage = parseLcov(readFileSync("coverage/lcov.info", "utf8"));
  const measured = measure(coverage);
  const policy = JSON.parse(readFileSync(policyFile, "utf8")) as Policy;
  const baseline = assemble(policy, readPackages("."));
  if (process.argv.includes("--update")) {
    const next = raise(measured, baseline);
    for (const [name, lines] of Object.entries(next.packages)) {
      const file = packageJsonOf(".", name);
      if (existsSync(file) && lines !== baseline.packages[name]) writeFileSync(file, withLines(readFileSync(file, "utf8"), lines));
    }
    writeFileSync(policyFile, JSON.stringify({ ...policy, overall: next.overall }, null, 2) + "\n");
    console.log(`baseline raised: ${percent(totalsOf(coverage))} measured, overall baseline ${next.overall}%`);
  } else {
    const failures = [...check(measured, baseline), ...checkFiles(coverage, baseline)];
    for (const [name, value] of measured) console.log(`${name.padEnd(18)} ${value.toFixed(1).padStart(6)}%  (baseline ${(name === "(all packages)" ? baseline.overall : baseline.packages[name])?.toFixed(1) ?? "none"}%)`);
    const lowest = [...coverage].filter(([f]) => packageOf(f) !== null).map(([f, l]) => [f, totalsOf(new Map([[f, l]]))] as const).sort((a, b) => a[1].hit / a[1].total - b[1].hit / b[1].total).slice(0, 3);
    console.log("\nlowest files: " + lowest.map(([f, t]) => `${f} ${percent(t)}`).join(", "));
    if (failures.length > 0) {
      console.error("\nCoverage check failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
      console.error("\nAdd tests for the code you changed. If lines were removed on purpose, lower the package's `crablet.coverage.lines` in its package.json by hand and say why in the commit message.");
      process.exit(1);
    }
    console.log("\nCoverage is at or above its baseline.");
  }
}
