# Plan: improve test coverage, starting by measuring it properly

**Status:** all six steps done (2026-10-08). What remains is optional: mutation testing of the core packages (see "Limits of this check"), and watching the first weeks of CI for flapping., and re-scoped by what step 1 found (below). Decisions taken by the owner: CI collects coverage from the integration tests too; the headline number is **the packages only** (the examples are
not counted); the ratchet is a hard gate that fails CI.

## Result of step 1 (2026-10-08): the real number is 98.5 %, not 67 %

Measured over the whole suite: the Bun unit tests (624) and the Node integration tests (322, against real Postgres), merged by `scripts/merge-coverage.ts`.

| Package | Lines covered | % |
|---|---|---|
| `automations`, `metrics-otel`, `test-support`, `views`, `views-http` | all | 100 % |
| `commands-http` | 353 / 354 | 99.7 % |
| `commands` | 827 / 836 | 98.9 % |
| `event-poller` | 581 / 593 | 98.0 % |
| `eventstore` | 835 / 859 | 97.2 % |
| `outbox` | 271 / 279 | 97.1 % |
| `db-migrations` | 17 / 19 | 89.5 % |
| **All packages** | **3752 / 3808** | **98.5 %** |

So the 67 % was an artefact of what was measured, as suspected, and most of this plan's original premise (large untested areas) was wrong. What is left is **56 lines**:

| File | Uncovered lines | Count |
|---|---|---|
| `packages/event-poller/src/EventSelection.ts` | 27-28,33-34,39-40,45-46 | 8 |
| `packages/eventstore/src/CommandAuditStore.ts` | 61-68 | 8 |
| `packages/outbox/src/internal/OutboxProgressTracker.ts` | 30,109-115 | 8 |
| `packages/eventstore/src/Tag.ts` | 25-31 | 7 |
| `packages/commands/src/ModelImpact.ts` | 87-88,168-170 | 5 |
| `packages/eventstore/src/internal/sql.ts` | 114-115,126-127 | 4 |
| `packages/commands/src/VerifyEvents.ts` | 133-134 | 2 |
| `packages/commands/src/testing/EventFixtures.ts` | 73-74 | 2 |
| `packages/db-migrations/src/index.ts` | 25-26 | 2 |
| `packages/event-poller/src/EventProcessor.ts` | 391-392 | 2 |
| `packages/event-poller/src/internal/identifiers.ts` | 8-9 | 2 |
| `packages/eventstore/src/EventStore.ts` | 165-166 | 2 |
| `packages/eventstore/src/NotifyPayload.ts` | 80-81 | 2 |
| `packages/commands-http/src/CommandApiLive.ts` | 104 | 1 |
| `packages/eventstore/src/testing/InMemoryEventStore.ts` | 97 | 1 |

**How the merged number is defined**, because it is easy to get wrong. Node (V8) reports whole ranges, so adding its report to Bun's naively marks imports, comments and blank lines as covered and gives 99.2 % with 7,032 lines instead of 3,808. The
merge therefore counts a line as executable if Bun reports it (Bun reports statements) or Node reports it as *not executed*; a line only Node reports, as executed, is not counted. A file Bun never loaded (five small ones) is judged
by its code lines, taken from the source. A line is covered if either suite ran it. Test code, diagnostics, tutorial tests and scripts are left out. Two imprecisions remain, both small: a comment inside a block Node reports as
not executed counts as a miss, and the five files use a heuristic. The two alternatives tried (Bun's lines plus Node's misses, and a pure source heuristic) gave 98.6 % and 98.8 %.

**What it does not tell us.** Line coverage says a line ran, not that a test would fail if it were wrong. At 98.5 % the useful question is no longer "which lines are not run" but "which behaviour would a regression slip past"; see step 4.

**Timings.** The integration suite with coverage took about 4½ minutes locally (Node 25.2.1, concurrency 4). My first attempt looked hung and was killed at 10 minutes; it was only slow, and I should have waited.

## Result of step 4 (2026-10-08): 99.7 % locally, and the tests were put to the test

**Part 1, the lines.** Tests were written for the behaviour behind the 56 lines (not to execute them): the odd-argument error of `Tag.ofPairs`, the unions of `EventSelection`, unsafe SQL identifiers, the exact-tag wake-up filter, an unreadable fixture in the change-impact report, a fixture that cannot be rebuilt, the migration list against the directory, processor pause/resume/status, the outbox progress tracker (pause, the error count, forward-only cursor, the table not migrated yet), the command audit store (`storeCommand`, `storeCommandIfAbsent`, `purge`), `verify-events` on an event that decodes but cannot be rebuilt, a 409 `DCB_VIOLATION` over HTTP when no retry is left, and two cases in the conformance suite that run against both stores (projecting with no projector is a defect; an unreadable event fails the projection with an `EventDecodingError` and is never skipped). Merged coverage of the packages went from 98.5 % to **99.7 %** (3,797 of 3,811 lines on CI, which also measures `test-support` at 96.4 %, see the note in `coverage-baseline.json`), and the baselines were raised to match.

**What is left: 11 lines, none of them a gap.** Nine are lines the tools attribute wrongly, not code: closing braces and a comment that Node reports as not executed (`ModelImpact.ts` 87-88, `db-migrations/src/index.ts` 26, `InMemoryEventStore.ts` 97, the `}` after each defect below) and three parameter-type lines of `assertModelImpact` (168-170). Two are deliberate: `sql.ts` 114 and 126 are defects for "the SQL function returned no result" and "returned success without a transaction id", which `append_events_if` does not do; a test would need a fake database. They stay recorded here.

**Part 2, would the tests notice a regression?** Seventeen deliberate breaks of the correctness core, one at a time, each run against the tests that could catch it (the unit suite, or the integration tests of the package for a database change); the source was restored after each.

| Break | Caught by |
|---|---|
| Poller: no fence before the handler | the leadership fence tests |
| Poller: no fence before the cursor moves | the leadership fence tests |
| Poller (Postgres) and outbox cursor update no longer forward-only | the tracker integration tests (two mutants) |
| Append condition cursor compared inclusively, in SQL (V7) and in the spec | conformance, append and cursor tests (two mutants) |
| Idempotency reported as a conflict | the conformance suite |
| Model query drops the scope tags | the model tests |
| `all(...)` takes the later horizon by transaction id | the model and union-boundary tests |
| Unreadable event skipped instead of failing, in the in-memory store and in Postgres | the new conformance case, and the event-decoding integration test (two mutants) |
| Wake-up filter inverted, tag keys not lower-cased, marker range check removed | their unit tests |
| **Conflicts never retried** | **survived** the unit suite; **now caught** by new `conflict-retry.test.ts` (it was covered only by Postgres concurrency tests) |
| **`all(...)` takes the later horizon by position** | **survived**; **now caught** by new `log-position.test.ts` (the position branch of `earliest` was never exercised; both member horizons have position 0 in the Postgres path) |
| **Leader heartbeat replaced by `SELECT 1`** (the original zombie-leader bug) | **survived** the integration tests, which kill the session; **now caught** by new `leader-session.test.ts`, which uses a stand-in connection that answers queries but holds no lock |

Three of seventeen survived, all three now caught. The third is the important one: the test that was written for the zombie-leader bug killed the session, which `SELECT 1` also detects; the failure it was written for (a connection that comes back on a new session, answering but without the lock) was not reproduced. The new test reproduces it deterministically, with no database.

**Limits of this check.** Seventeen breaks chosen by hand, not a systematic mutation run; a tool that generates mutants would find more. The surviving three were found because the sample was aimed at the riskiest code, which is the argument for a tool only if this sample keeps finding gaps. It did, so mutation testing of `eventstore`, `commands` and `event-poller` is a reasonable next decision, not made here.

## Where we were before step 1

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

### 1. Measure the whole suite (the largest effect) - DONE (2026-10-08)

Built: `bun run test:coverage` (unit with coverage, integration with coverage, merge) and `scripts/merge-coverage.ts` with tests; CI runs the same and uploads the merged `coverage/lcov.info`. The baseline is in "Result of step 1" above. CI itself is the first run of the Node coverage flags on Node 24; if it misbehaves, revert the workflow to the plain integration step.

- Run the integration tests with `node --test --experimental-test-coverage` and the lcov reporter, including only `packages/*/src/**/*.ts`; run the unit suite with Bun's lcov as now.
- Merge the two lcov files by line (a line is covered if either suite hit it) with a small script in the repository (`scripts/merge-coverage.ts`), and write one `coverage/lcov.info`.
- Change CI to do both and upload the merged file to Codecov. The integration step already runs in CI; it gains the coverage flags and a few minutes if any.
- Record the **baseline** here, per package, as soon as it exists.

Done when: CI shows one merged number for the packages, and this plan has the baseline table.

### 2. Count only the packages - DONE (2026-10-08)

Built: the merged `coverage/lcov.info` that CI uploads contains the packages only (test code, diagnostics, tutorial tests and scripts were already left out; now the examples are too); the examples' number (66.4 %, unit tests only) is printed in the log, not gated. `codecov.yml` repeats the ignores with a reason for each and sets the Codecov statuses (project: no lower than the base commit, 0.3 % threshold; patch: the lines a change adds should be 90 % covered).

- Add `codecov.yml` that ignores `examples/**`, `**/test/**`, `**/diagnostics/**`, and the type-only files that have no executable lines; keep the same exclusions in the merge script so the local and the uploaded numbers agree.
- Report the examples' coverage separately (a Codecov flag or a line in the CI log), without a threshold.

Done when: the badge and the Codecov page show packages only, and a comment in `codecov.yml` says why each ignore is there.

### 3. The ratchet: a hard gate - DONE (2026-10-08)

Built: `coverage-baseline.json` (per package and overall, rounded down to a tenth, plus a tolerance of 0.3 points), `scripts/coverage-gate.ts` (`bun run coverage:check` fails on a regression; `bun run coverage:baseline` raises the baseline and never lowers it), a CI step between the merge and the upload, and the upload now runs even when the gate fails so Codecov shows the drop. Checked by a unit test of the logic and by hand: raising `eventstore` to 99.5 % in the file made the check exit 1 with the package named.

**What the gate does not catch.** It works on percentages with a tolerance, so a change that adds a few untested lines to a large package can stay inside it (0.3 points of `commands` is about 3 lines). Codecov's patch status (90 % of the added lines) is the guard for that, but it blocks a merge only if branch protection requires it; the hard gate in CI guards against drops larger than the tolerance. The baseline was measured on macOS with Node 25; if the first CI run (Linux, Node 24) differs on a package by more than the tolerance, set that baseline from the CI number and say so in the commit.

- A package may not lose coverage: CI fails if a package's merged line coverage falls below its recorded baseline (a small committed JSON, `coverage-baseline.json`, updated by the commit that
  raises it). A change that adds code is also checked on its own lines (Codecov patch status, target the package's current level).
- Raise the baselines as steps 4 and 5 land. Lowering one needs a reason in the commit message.

Done when: a pull request that deletes a test, or adds untested code to a package, fails.

### 4. Close the 56 lines, then ask whether the tests would notice a regression - DONE (2026-10-08)

See "Result of step 4" above.

1. **The 56 lines** in the table above. Most are small and some are real behaviour: the odd-argument error in `Tag.of`, the type union in `EventSelection`, a failure path in `CommandAuditStore`, the outbox `updateStatus` path,
   the `append_events_if` "no result" defect in `sql.ts`, parts of `ModelImpact`. Cover each with a test that asserts the behaviour, or record why it is deliberately not covered (for example `Effect.die` branches for "cannot happen").
2. **Would a regression be noticed?** A line that ran can still be unasserted. Sample the correctness core (`eventstore`, `commands`, `event-poller`): break a line on purpose (flip a condition in the append condition check, drop the fence,
   let the cursor move backwards) and see whether a test fails. Where none does, add the test. If this finds gaps in the sample, a mutation-testing tool is the systematic version; that is a separate, optional decision.

Done when: the table is empty or each remaining line has a recorded reason, and the sampled breaks are all caught.

### 5. Targets - DONE (2026-10-08)

The proposed 85 % was below where we already were, so it was withdrawn and replaced by targets that are enforced, not wished for:

| Measure | Target | Enforced by |
|---|---|---|
| Packages, merged line coverage | hold the baseline (99.6 % on CI) | the ratchet per package and overall (step 3), 0.3-point tolerance |
| Any single source file | **90 %**, unless listed with a reason | `fileFloor` in `coverage-baseline.json`; today the lowest is `ModelImpact.ts` at 94.5 % and the exclusion list is empty |
| An exception to the file floor | must be current | a stale entry (file gone, or above the floor) fails the check, so the list cannot grow silently or outlive its reason |
| Failures and edge cases | each failure path has a test that fails when the behaviour breaks | the 17 deliberate breaks of step 4 (14 caught at once, 3 found and closed) |

The gate never has to be loosened to reach these; it ratchets up. Raising a baseline: `bun run coverage:baseline`, then set `test-support` back to the CI number if the local one is higher (see the note in the file).

### 6. Keep it honest - DONE (2026-10-08)

- `CONTRIBUTING.md` explains `bun run test:coverage`, the gate, the file floor, the exclusions and where they are written, and keeps the rule that a bug fix starts with a failing test (it was already in "Making a change").
- The exclusions, which used to live in two places that could drift, are now checked against each other: `scripts/coverage-exclusions.test.ts` fails if something the merge leaves out is not ignored by `codecov.yml`, or if a package source is ignored. The "review the list periodically" item became mechanical: stale exceptions fail the build.

## Risks and costs

- **CI time.** Running the integration tests with coverage may add a minute or two; the job is already the longest.
- **Node's coverage of type-stripped TypeScript** reports lines of the original file, because stripping keeps line numbers. If a file's mapping is wrong the merged number for it is wrong; step 1 spot-checks several files against the unit report.
- **A gate can block a good change** (for example deleting dead code lowers a count). The baseline is per package and percentage-based, so removing code with its tests does not trip it.
- **Parallel integration processes** each produce coverage; Node merges them into one lcov for the run. Confirmed on a single file; the full-suite merge is what the run in progress checks.

## How we will know

- The Codecov page shows one number for the packages, and it equals the number from the local script.
- A deliberate regression (delete a test of the leader fence) turns CI red.
- The step 4 list is closed, file by file, with the commit that closed it.
