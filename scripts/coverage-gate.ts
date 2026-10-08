// The coverage ratchet (docs/plans/test-coverage.md, step 3): a package may not lose coverage. It compares the merged report (coverage/lcov.info, packages only) with the committed
// baseline (coverage-baseline.json) and fails when a package, or the packages as a whole, falls below its baseline by more than the tolerance.
//
//   bun scripts/coverage-gate.ts                 # check: exit 1 on a regression
//   bun scripts/coverage-gate.ts --update        # raise the baseline to the current numbers (it never lowers one)
//
// The tolerance (a few tenths of a percentage point) absorbs run-to-run differences such as a line a racy test only sometimes reaches. Percentages, not line counts, so deleting code
// together with its tests does not trip the gate. Lowering a baseline is done by editing the file by hand, with the reason in the commit message.
import { readFileSync, writeFileSync } from "node:fs";
import { packageOf, parseLcov, percent, totalsOf, type Coverage } from "./merge-coverage.ts";

export interface Baseline {
  readonly notes?: Readonly<Record<string, string>>;
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
    if (now === undefined) failures.push(`${name}: no coverage measured (baseline ${floor.toFixed(1)}%). Was the package removed? Then remove it from coverage-baseline.json.`);
    else if (now < floor - baseline.tolerancePoints) failures.push(`${name}: ${now.toFixed(1)}% is below its baseline ${floor.toFixed(1)}% (tolerance ${baseline.tolerancePoints} points)`);
  };
  expect("(all packages)", baseline.overall);
  for (const [name, floor] of Object.entries(baseline.packages)) expect(name, floor);
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
  return { ...(baseline.notes === undefined ? {} : { notes: baseline.notes }), tolerancePoints: baseline.tolerancePoints, overall: Math.max(baseline.overall, floor1(measured.get("(all packages)") ?? 0)), packages: sorted };
};

if (import.meta.main) {
  const baselineFile = "coverage-baseline.json";
  const coverage = parseLcov(readFileSync("coverage/lcov.info", "utf8"));
  const measured = measure(coverage);
  const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as Baseline;
  if (process.argv.includes("--update")) {
    const next = raise(measured, baseline);
    writeFileSync(baselineFile, JSON.stringify(next, null, 2) + "\n");
    console.log(`baseline raised: ${percent(totalsOf(coverage))} measured, overall baseline ${next.overall}%`);
  } else {
    const failures = check(measured, baseline);
    for (const [name, value] of measured) console.log(`${name.padEnd(18)} ${value.toFixed(1).padStart(6)}%  (baseline ${(name === "(all packages)" ? baseline.overall : baseline.packages[name])?.toFixed(1) ?? "none"}%)`);
    if (failures.length > 0) {
      console.error("\nCoverage fell below its baseline:\n" + failures.map((f) => `  - ${f}`).join("\n"));
      console.error("\nAdd tests for the code you changed. If lines were removed on purpose, lower the baseline in coverage-baseline.json by hand and say why in the commit message.");
      process.exit(1);
    }
    console.log("\nCoverage is at or above its baseline.");
  }
}
