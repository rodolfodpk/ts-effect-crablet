// What coverage leaves out is written down in two places that must agree: the merge script (isMeasured, which decides what is in the uploaded report) and codecov.yml (the ignores,
// the second guard on Codecov's side). If they drift, the number on Codecov stops matching the number in the log. docs/plans/test-coverage.md, step 6.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isMeasured } from "./merge-coverage.ts";

const ignores = [...readFileSync("codecov.yml", "utf8").matchAll(/^\s+- "([^"]+)"/gmu)].map((m) => m[1]!);
const ignored = (file: string): boolean => ignores.some((pattern) => new Bun.Glob(pattern).match(file));

describe("coverage exclusions", () => {
  test("codecov.yml lists its ignores", () => {
    expect(ignores.length).toBeGreaterThanOrEqual(4);
  });

  test("everything the merge leaves out, Codecov ignores too", () => {
    const leftOut = [
      "packages/commands/test/support/transfer.ts",
      "packages/commands/test/quickstart.test.ts",
      "packages/eventstore/diagnostics/storage.diagnostic.ts",
      "packages/db-migrations/test/migrations.test.ts",
      "examples/course-enrolment-app/tutorial/step1-capacity-only.test.ts",
      "scripts/merge-coverage.ts"
    ];
    for (const file of leftOut) {
      expect(isMeasured(file), `${file} is left out by the merge`).toBe(false);
      expect(ignored(file), `${file} is ignored by codecov.yml`).toBe(true);
    }
  });

  test("the package sources, which are what coverage is about, are neither left out nor ignored", () => {
    for (const file of ["packages/eventstore/src/Leader.ts", "packages/commands/src/testing/Scenario.ts", "packages/event-poller/src/internal/sql.ts", "packages/test-support/src/index.ts"]) {
      expect(isMeasured(file), file).toBe(true);
      expect(ignored(file), file).toBe(false);
    }
  });
});
