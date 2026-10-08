# Plan: improve test coverage, starting by measuring it properly

**Status:** proposed (2026-10-08). Decisions taken by the owner: CI collects coverage from the integration tests too; the headline number is **the packages only** (the examples are
not counted); the ratchet is a hard gate that fails CI.

## Where we are

CI uploads one number: the line coverage of the Bun **unit** suite, which is **66.6 %** of lines (80.5 % of functions) over all 143 source files. That number is misleading in two ways.

1. **It leaves out the 322 integration tests.** They run under Node against a real Postgres and nothing measures them. The least-covered files are the ones that need a database, so the
   unit number says "untested" about code the integration tests exercise:

   | File | Unit-only line coverage |
   |---|---|
   | `packages/outbox/src/internal/OutboxProgressTracker.ts` | 5 % |
   | `packages/event-poller/src/PostgresProgressTracker.ts` | 6 % |
   | `packages/eventstore/src/Leader.ts` | 6 % |
   | `packages/event-poller/src/internal/sql.ts` | 4.5 % |
   | `packages/eventstore/src/internal/sql.ts` | 8 % |
   | `packages/commands/src/VerifyEvents.ts` | 5 % |
   | `packages/commands-http/src/CommandApiLive.ts` | 14 % |
   | `packages/eventstore/src/EventStore.ts` | 16 % |
   | `packages/views/src/WaitUntilProcessed.ts` | 12 % |
   | `packages/commands/src/CommandExecutor.ts` | 34 % |

   Node can measure TypeScript run by type-stripping (`node --test --experimental-test-coverage`, lcov reporter). Checked on one file: running only the outbox integration test gave
   `OutboxProgressTracker` 137 of 145 lines hit, against 7 of 132 in the unit suite.
2. **It counts the examples.** About a third of the measured lines are in the four example applications (demonstration code: projectors, query endpoints, a UI). They should not set the
   number a library is judged by.

Packages only, unit suite only, today:

| Package | Lines hit / total | % |
|---|---|---|
| `commands` | 890 / 1147 | 78 % |
| `views-http` | 211 / 220 | 96 % |
| `metrics-otel`, `test-support` | 92 / 92 | 100 % |
| `commands-http` | 233 / 354 | 66 % |
| `eventstore` | 659 / 1061 | 62 % |
| `event-poller` | 445 / 687 | 65 % |
| `automations` | 99 / 161 | 62 % |
| `views` | 162 / 332 | 49 % |
| `outbox` | 97 / 279 | 35 % |
| **All packages** | **2888 / 4333** | **66.7 %** |

(`db-migrations` has no TypeScript worth measuring.) Everything below the 66.7 % is a candidate, but several of those gaps will close in step 1 without a single new test.

## Principles

- **Measure before writing tests.** The first step may move the number more than all the others.
- **Coverage finds untested code; it does not prove tests are good.** A line hit by a test that asserts nothing is not coverage worth having. Prefer tests of behaviour, especially of failures.
- **Risk first.** A line of leader election or of the append matters more than a line of a log message. Order the work by what would hurt if it broke.
- **No tests that pin implementation text.** The SQL builders are string-building functions; the integration equivalence tests check what the queries return, which is what matters.
- **Do not game the number.** Excluding a file needs a reason written down, in the file or in this plan.

## The steps

Each is its own commit.

### 1. Measure the whole suite (the largest effect)

- Run the integration tests with `node --test --experimental-test-coverage` and the lcov reporter, including only `packages/*/src/**/*.ts`; run the unit suite with Bun's lcov as now.
- Merge the two lcov files by line (a line is covered if either suite hit it) with a small script in the repository (`scripts/merge-coverage.ts`), and write one `coverage/lcov.info`.
- Change CI to do both and upload the merged file to Codecov. The integration step already runs in CI; it gains the coverage flags and a few minutes if any.
- Record the **baseline** here, per package, as soon as it exists.

Done when: CI shows one merged number for the packages, and this plan has the baseline table.

### 2. Count only the packages

- Add `codecov.yml` that ignores `examples/**`, `**/test/**`, `**/diagnostics/**`, and the type-only files that have no executable lines; keep the same exclusions in the merge script so the local and the uploaded numbers agree.
- Report the examples' coverage separately (a Codecov flag or a line in the CI log), without a threshold.

Done when: the badge and the Codecov page show packages only, and a comment in `codecov.yml` says why each ignore is there.

### 3. The ratchet: a hard gate

- A package may not lose coverage: CI fails if a package's merged line coverage falls below its recorded baseline (a small committed JSON, `coverage-baseline.json`, updated by the commit that
  raises it). A change that adds code is also checked on its own lines (Codecov patch status, target the package's current level).
- Raise the baselines as steps 4 and 5 land. Lowering one needs a reason in the commit message.

Done when: a pull request that deletes a test, or adds untested code to a package, fails.

### 4. Fill the gaps that remain after the merge (risk first)

To be sharpened with the real list after step 1. The candidates from the unit data, ordered by risk:

1. **Failure paths of the pollers:** leadership lost between the two fences, the cursor update refused, the handler failing until `maxErrors`, backoff, pause and reset
   (`event-poller`, `views`, `outbox`, `automations`). Many have integration tests for the happy path only.
2. **The command audit:** `CommandAuditStore` (18 % unit) and `CommandAudit` (32 %): what is recorded, the personal-data guard, what a failed command leaves behind.
3. **The append's error mapping:** `AppendErrors` (16 %), deadlock and serialization failures turning into a retry (`CommandExecutor`).
4. **Module wiring:** `ViewsModule`, `AutomationsModule`, `OutboxModule` start, stop, and a disabled processor.
5. **`VerifyEvents`** (5 % unit): the sampling modes and the exit conditions, against a database with a known unreadable event.
6. **`WaitUntilProcessed` and the hub** under timeouts and reconnects.

For each: write the test that fails if the behaviour breaks (mutate the code once to see it fail), not the test that merely executes the lines.

Done when: every file in the packages is above 60 % merged, and the items above are each covered or recorded as deliberately not.

### 5. Targets

Proposed, to confirm after step 1 with the real baseline:

| Measure | Target |
|---|---|
| Packages, merged line coverage | 85 % |
| Any single file | 60 %, unless excluded with a reason |
| The correctness core (`eventstore`, `commands`, `event-poller`) | 90 % |

The gate (step 3) ratchets up to these; it never has to be loosened to reach them.

### 6. Keep it honest

- A short note in `CONTRIBUTING.md`: how to produce the merged report locally (`bun run test:coverage`, a script that runs both suites and merges), and the rule that a bug fix starts with a failing test.
- Review the exclusions list once per quarter-sized plan, so it does not grow silently.

## Risks and costs

- **CI time.** Running the integration tests with coverage may add a minute or two; the job is already the longest.
- **Node's coverage of type-stripped TypeScript** reports lines of the original file, because stripping keeps line numbers. If a file's mapping is wrong the merged number for it is wrong; step 1 spot-checks several files against the unit report.
- **A gate can block a good change** (for example deleting dead code lowers a count). The baseline is per package and percentage-based, so removing code with its tests does not trip it.
- **Parallel integration processes** each produce coverage; Node merges them into one lcov for the run. Confirmed on a single file; the full-suite merge is what the run in progress checks.

## How we will know

- The Codecov page shows one number for the packages, and it equals the number from the local script.
- A deliberate regression (delete a test of the leader fence) turns CI red.
- The step 4 list is closed, file by file, with the commit that closed it.
