// The mutation score gate (docs/history/plans/mutation-testing.md, step 3). It reads Stryker's report of tier 1 (tools/mutation/reports/mutation.json, written by `bun run mutation`) and
// compares it with the committed baseline (tools/mutation/baseline.json). It fails when a package, or tier 1 as a whole, falls below its baseline by more than the tolerance: the score
// may not go down.
//
//   bun scripts/mutation-gate.ts             # check: exit 1 on a regression
//   bun scripts/mutation-gate.ts --update    # raise the baseline to the current scores (it never lowers one)
//
// The score is Stryker's: mutants killed or timed out, over those plus the ones that survived or that no test reached. Ignored mutants and compile or runtime errors do not count. The
// tolerance absorbs run-to-run noise, such as a mutant that a test depending on real time kills on one run and not on the next. Lowering a baseline is done by editing the file by hand,
// with the reason in the commit message, as for coverage (scripts/coverage-gate.ts, whose `raise` this reuses).
import { readFileSync, writeFileSync } from "node:fs";
import { raise as raiseCoverage, type Baseline, type Measured } from "./coverage-gate.ts";

type Status = "Killed" | "Timeout" | "Survived" | "NoCoverage" | "Ignored" | "CompileError" | "RuntimeError" | "Pending";
export interface Report {
  readonly files: Readonly<Record<string, { readonly mutants: ReadonlyArray<{ readonly status: Status }> }>>;
}

const ALL = "(tier 1)";
const packageOf = (file: string): string | null => /^packages\/([^/]+)\//.exec(file)?.[1] ?? null;

// package name -> mutation score in percent, and the key "(tier 1)" for the whole
export const measure = (report: Report): Measured => {
  const counts = new Map<string, { detected: number; valid: number }>();
  const add = (name: string, status: Status): void => {
    const c = counts.get(name) ?? { detected: 0, valid: 0 };
    if (status === "Killed" || status === "Timeout") c.detected++;
    if (status === "Killed" || status === "Timeout" || status === "Survived" || status === "NoCoverage") c.valid++;
    counts.set(name, c);
  };
  for (const [file, { mutants }] of Object.entries(report.files)) {
    const name = packageOf(file);
    if (name === null) continue;
    for (const { status } of mutants) {
      add(name, status);
      add(ALL, status);
    }
  }
  const out = new Map<string, number>();
  for (const [name, c] of [...counts].sort(([a], [b]) => a.localeCompare(b))) if (c.valid > 0) out.set(name, (100 * c.detected) / c.valid);
  return out;
};

export const check = (measured: Measured, baseline: Baseline): ReadonlyArray<string> => {
  const failures: Array<string> = [];
  const expect = (name: string, floor: number): void => {
    const now = measured.get(name);
    if (now === undefined) failures.push(`${name}: no mutants measured (baseline ${floor.toFixed(1)}%). Was the package removed from tier 1? Then remove it from tools/mutation/baseline.json.`);
    else if (now < floor - baseline.tolerancePoints) failures.push(`${name}: ${now.toFixed(1)}% is below its baseline ${floor.toFixed(1)}% (tolerance ${baseline.tolerancePoints} points)`);
  };
  expect(ALL, baseline.overall);
  for (const [name, floor] of Object.entries(baseline.packages)) expect(name, floor);
  return failures;
};

// A new baseline, as the coverage gate raises one (it reads the whole under the key "(all packages)").
export const raise = (measured: Measured, baseline: Baseline): Baseline =>
  raiseCoverage(new Map([...measured].map(([name, value]) => [name === ALL ? "(all packages)" : name, value])), baseline);

if (import.meta.main) {
  const baselineFile = "tools/mutation/baseline.json";
  const measured = measure(JSON.parse(readFileSync("tools/mutation/reports/mutation.json", "utf8")) as Report);
  const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as Baseline;
  if (process.argv.includes("--update")) {
    const next = raise(measured, baseline);
    writeFileSync(baselineFile, JSON.stringify(next, null, 2) + "\n");
    console.log(`baseline raised: tier 1 measured ${measured.get(ALL)?.toFixed(1)}%, baseline ${next.overall}%`);
  } else {
    for (const [name, value] of measured) console.log(`${name.padEnd(14)} ${value.toFixed(1).padStart(6)}%  (baseline ${(name === ALL ? baseline.overall : baseline.packages[name])?.toFixed(1) ?? "none"}%)`);
    const failures = check(measured, baseline);
    if (failures.length > 0) {
      console.error("\nMutation score check failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
      console.error("\nOpen tools/mutation/reports/mutation.html for the surviving mutants, and add the tests that kill them. If one is equivalent, mark it with a `// Stryker disable` comment and its reason.");
      process.exit(1);
    }
    console.log("\nThe mutation score is at or above its baseline.");
  }
}
