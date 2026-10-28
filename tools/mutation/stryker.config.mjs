// @ts-check
import { readdirSync } from "node:fs";
// Mutation testing, tier 1 (docs/history/plans/mutation-testing.md): the pure and in-memory core of eventstore, commands and event-poller, killed by
// their Bun unit tests. Once, `cd tools/mutation && bun install` (its own install, so Stryker gets TypeScript 5.9 while the root keeps 7); then, from the
// repository root, `bun run mutation`, then `bun run mutation:check`: the ratchet against tools/mutation/baseline.json (scripts/mutation-gate.ts; CI runs both
// weekly, .github/workflows/mutation.yml). Reports in tools/mutation/reports. The database-bound code is tier 2 (a list of breaks).
const CORE = ["eventstore", "commands", "event-poller"];
// The unit tests only: the top-level `*.test.ts` of each package (test/integration runs under Node with Testcontainers, which this runner cannot drive).
const unitTests = CORE.flatMap((p) => readdirSync(`packages/${p}/test`).filter((f) => f.endsWith(".test.ts")).map((f) => `packages/${p}/test/${f}`));

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ["@hughescr/stryker-bun-runner"],
  testRunner: "bun",
  coverageAnalysis: "perTest",
  mutate: [
    ...CORE.map((p) => `packages/${p}/src/**/*.ts`),
    // Exercised by the integration tests only (Postgres): their mutants would all be "no coverage" here and say nothing. They are tier 2, a list of
    // deliberate breaks run against Postgres (the plan, step 4). Found by the first run (2026-10-27): no unit test reaches them, or almost none.
    ...[
      "commands/src/CommandAudit.ts",
      "commands/src/Crablet.ts",
      "commands/src/VerifyEvents.ts",
      "event-poller/src/PostgresProgressTracker.ts",
      "event-poller/src/SqlEventFetcher.ts",
      "event-poller/src/internal/sql.ts",
      "eventstore/src/CommandAuditStore.ts",
      "eventstore/src/EventStore.ts",
      "eventstore/src/Storage.ts",
      "eventstore/src/internal/sql.ts"
    ].map((f) => `!packages/${f}`)
  ],
  bun: { testFiles: unitTests, timeout: 120_000 },
  // Module-level code (schemas, constants built at import): only a whole-suite run could kill its mutants, so they are skipped, as the plan says.
  ignoreStatic: true,
  // String literals are mostly SQL text, log and error messages: their mutants are equivalent noise.
  mutator: { excludedMutations: ["StringLiteral"] },
  // Mutate the files where they are, not in a sandbox copy. Each package's node_modules links its sibling packages (`@crablet/eventstore`), and Stryker
  // links those folders back to the repository: in a sandbox, a commands test imports the eventstore source unmutated, so the eventstore mutants that
  // only the commands tests reach always survive (found 2026-10-27: tier 1 was 77.6 % in a sandbox, 79.1 % in place). Stryker restores the files when
  // it ends, including on Ctrl-C; do not edit the sources while it runs (after a crash, `git checkout packages` restores them).
  inPlace: true,
  concurrency: 4,
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "tools/mutation/reports/mutation.html" },
  jsonReporter: { fileName: "tools/mutation/reports/mutation.json" },
  tempDirName: "tools/mutation/.stryker-tmp",
  // The docs and examples are not ignored: some unit tests check the guides and links against them.
  ignorePatterns: ["coverage", "tools/mutation", ".git"],
  cleanTempDir: "always"
};
