# Plan: mutation testing for the core packages

**Status:** steps 0 and 1 done (2026-10-27): the tooling is in `tools/mutation/` and `bun run mutation` measures tier 1 in about a minute (once: `cd tools/mutation && bun install`); the baseline
is below. Step 2, the triage, is under way (nineteen files done, see its progress table). Since 2026-10-27 it mutates in place (`inPlace` in the config): in Stryker's
sandbox, one package's tests imported the other packages' sources unmutated. Step 3 done (2026-10-27): a ratchet (`bun run mutation:check`, baseline in
`tools/mutation/baseline.json`), run on demand and weekly in CI, not on pull requests (see step 3 for why). Proposed 2026-10-08, with a pilot.

## Why

Line coverage says a line ran. It does not say a test would fail if the line were wrong. The [coverage plan](./test-coverage.md) reached 99.7 % and then checked the tests the other way: 17 deliberate breaks of the
correctness core, by hand. Three survived (conflict retries, `earliest` by position, and the leader heartbeat that had to ask `pg_locks`), and all three were real gaps with 100 % line coverage over them. A tool that
makes those breaks systematically would find more; this plan is how to try that without spending the project's time on noise.

## What a pilot showed (2026-10-08, in a throwaway copy of the repository, nothing committed)

Tool: StrykerJS 10.0.0 (the official core) with a community Bun runner, `@hughescr/stryker-bun-runner` 1.4.0 (per-test coverage through Bun's inspector; needs Bun 1.3.7 or newer, we have 1.4.2). Scope: five small files whose tests
are all unit tests: `Tag.ts`, `LogPosition.ts`, `Marker.ts`, `NotifyPayload.ts` (eventstore) and `Model.ts` (commands). The unit suite, selected with `bun.testFiles`, concurrency 4, per-test coverage.

| File | Mutants killed | Survived | No coverage | Score |
|---|---|---|---|---|
| `Tag.ts` | 16 | 0 | 0 | 100 % |
| `Marker.ts` | 21 | 0 | 0 | 100 % |
| `Model.ts` | 52 | 5 | 0 | 91 % |
| `NotifyPayload.ts` | 118 | 23 | 4 | 81 % |
| `LogPosition.ts` | 24 | 16 | 1 | **59 %** |
| **All five** | **231** | **44** | **5** | **82.5 %** |

- **Speed is not the problem.** 311 mutants instrumented, 280 run, in **9 seconds**, because per-test coverage runs only the tests that cover the mutated line (1.8 tests per mutant on average).
- **The signal is real.** `LogPosition.ts` has 100 % line coverage and a 59 % mutation score. `Model.lifecycleQuery` (the query `withLifecycleGuard` uses) can be replaced by an empty array and no test notices. The deduplication of types in a model's query, and
  `all({})` with no members, are likewise untested.
- **So is the noise.** Many survivors are equivalent mutants (for example `size > 0` becoming `size >= 0` in a guard where both give the same answer, or a string literal in an error message). They have to be triaged, once, and marked.
- **A blocker, and a workaround.** Stryker 10 calls `ts.parseConfigFileTextToJson`, which the repository's TypeScript 7.0.2 (the native compiler) does not have; it failed at start-up. The pilot installed TypeScript 5.9 in the copy. I did not test
  Stryker's TypeScript checker plugin (which filters mutants that do not compile), which needs the same compiler API.
- The community plugin must be listed in `plugins` (the default only loads `@stryker-mutator/*`), and it is one person's project at version 1.4.0.

What the pilot did **not** cover: the code that needs a database (`Leader`, the progress trackers, the SQL builders, `EventStore` against Postgres). Its tests run under Node's test runner with Testcontainers, which the Bun runner cannot drive, and a
whole-suite run per mutant costs 40 to 300 seconds (the 17 breaks by hand took 40 to 46 s per integration directory).

## Principles

- **Two tiers, because the tests are in two worlds.** Pure and in-memory logic is tested by the Bun unit suite and can be mutated fast and systematically. Database-bound logic is tested by integration tests and is mutated deliberately, from a list, not exhaustively.
- **The tool must not touch the repository's own toolchain.** The TypeScript 7 problem means the mutation tooling lives in its own workspace folder with its own dependencies; the root keeps TypeScript 7 and the exact pins of ADR-0009.
- **Survivors are triaged, never ignored and never all "fixed".** Each is a real gap (write the test), an equivalent mutant (mark it with the reason), or out of scope (say why). Marking without a reason is not allowed.
- **A score is a ratchet, not a target to game.** Like coverage, it may not go down; it is not raised by deleting mutants or by tests that execute without asserting.

## The steps

Each is its own commit.

### 0. Decide the prerequisites (a short spike, then a decision)

1. **TypeScript.** Verify that Stryker works with its own `typescript@5.9` in an isolated folder (`tools/mutation/` with a `package.json` of its own, not a root dependency), while the root stays on 7.0.2. If workspace resolution makes that impossible, the alternatives are to wait for a
   Stryker release that supports TypeScript 7, or to run Stryker in its `command` mode without the compiler plugins.
2. **The Bun runner.** Pin its exact version (as ADR-0009 does for Effect). Check its licence and how it behaves in CI (Linux, Bun 1.4.2). Fallback if it breaks: Stryker's built-in `command` runner running `bun test` per mutant, without per-test coverage (slower by an order of
   magnitude, still feasible for the three core packages' pure files).
3. **CI cost.** Decide where it runs (see step 4).

Done when: a one-page decision in this plan says which of the options was chosen and why.

**Decision (2026-10-27).**

- **TypeScript: isolation works.** `tools/mutation/` has its own `package.json` and install, and is left out of the workspaces (`"!tools/mutation"` in
  the root `workspaces`), so Stryker reads the configuration with its own `typescript@5.9.3` while the root stays on 7.0.2 and the root lockfile does
  not change. Checked first on one file (`Tag.ts`: 16 of 16 killed, as in the pilot).
- **The runner:** `@hughescr/stryker-bun-runner` **1.6.0** (Apache-2.0; peer `typescript <7`, Stryker 9 or 10), with `@stryker-mutator/core` 10.1.1,
  both pinned. Its README now documents the TypeScript 7 problem and the workaround used here. The `command` runner stays the way out.
- **CI:** not yet; on demand (`bun run mutation`), by the owner's decision.

### 1. Tier 1: the pure and in-memory core, measured

- Scope: `packages/{eventstore,commands,event-poller}/src`, excluding files that only the integration tests exercise (they would all show as "no coverage" and mean nothing here): the list is generated from the merged coverage (files whose unit-only coverage is low).
- Configuration in `tools/mutation/`: unit tests selected with `bun.testFiles`, per-test coverage, `ignoreStatic`, the string-literal mutator switched off for SQL text and messages (they only produce equivalent noise), a JSON report, and an HTML report kept as a CI artifact.
- Output: the first score per file and per package, written into this plan as the baseline.

Done when: `bun run mutation` produces the report locally in minutes, and the baseline table is here.

**Baseline (2026-10-27, on Effect 4.0.6).** 3,006 mutants in 51 files, run in **1 minute 6 seconds** (concurrency 4, per-test coverage, the 533 unit
tests of the three packages). The configuration is `tools/mutation/stryker.config.mjs`: `ignoreStatic` (692 module-level mutants skipped), the
`StringLiteral` mutator off (SQL text and messages), and ten files left out because only the integration tests reach them (the first run found them
as all, or almost all, "no coverage": `EventStore.ts`, both `internal/sql.ts`, `Storage.ts`, `CommandAuditStore.ts`, `CommandAudit.ts`, `Crablet.ts`,
`VerifyEvents.ts`, `PostgresProgressTracker.ts`, `SqlEventFetcher.ts`); they are tier 2. Reports: `tools/mutation/reports/` (HTML and JSON, not
committed). "Covered score" leaves out the mutants no unit test reaches.

| Package | Killed | Survived | No coverage | Ignored (static) | Score | Covered score |
|---|---|---|---|---|---|---|
| `commands` | 819 | 189 | 111 | 449 | 73.2% | 81.2% |
| `event-poller` | 272 | 62 | 29 | 72 | 74.9% | 81.4% |
| `eventstore` | 584 | 155 | 93 | 171 | 70.2% | 79.0% |
| **All three** | 1,675 | 406 | 233 | 692 | 72.4% | 80.5% |

The pilot's findings hold: `LogPosition.ts` is still at **59 %** with full line coverage, `NotifyPayload.ts` at 81 %, `Tag.ts` and `Marker.ts` at 100 %.
`Model.ts` is lower than in the pilot (64 %, it was 91 %): the file grew (297 mutants, 57 then), with the change-impact metadata, `scope` and the
period resolver. The largest numbers of survivors are in `Model.ts` (86), `Leader.ts` (46), `EventProcessor.ts` (44), `ModelImpact.ts` (26), the
in-memory store (24) and `Personal.ts` (21): where step 2 would start, after the pilot's starting points. Per file, lowest first:

| File | Killed | Survived | No coverage | Score |
|---|---|---|---|---|
| `eventstore/src/EventDecoding.ts` | 1 | 4 | 1 | 17% |
| `commands/src/CommandExecutor.ts` | 15 | 1 | 46 | 24% |
| `eventstore/src/AppendCondition.ts` | 3 | 0 | 5 | 38% |
| `eventstore/src/CorrelationContext.ts` | 4 | 1 | 4 | 44% |
| `eventstore/src/AppendEvent.ts` | 17 | 8 | 12 | 46% |
| `eventstore/src/Query.ts` | 12 | 4 | 9 | 48% |
| `eventstore/src/testing/InMemoryEventStore.ts` | 39 | 24 | 9 | 54% |
| `eventstore/src/LogPosition.ts` | 24 | 13 | 4 | 59% |
| `commands/src/Errors.ts` | 20 | 4 | 9 | 61% |
| `event-poller/src/ProgressCursor.ts` | 12 | 2 | 5 | 63% |
| `commands/src/Model.ts` | 189 | 86 | 22 | 64% |
| `event-poller/src/EventProcessor.ts` | 127 | 44 | 24 | 65% |
| `eventstore/src/Leader.ts` | 131 | 46 | 22 | 66% |
| `eventstore/src/SessionClients.ts` | 31 | 3 | 12 | 67% |
| `eventstore/src/SharedListen.ts` | 24 | 3 | 7 | 71% |
| `commands/src/Personal.ts` | 99 | 21 | 14 | 74% |
| `commands/src/ModelImpact.ts` | 99 | 26 | 7 | 75% |
| `commands/src/CommandDecision.ts` | 16 | 3 | 2 | 76% |
| `eventstore/src/Listen.ts` | 26 | 7 | 1 | 76% |
| `commands/src/Repeat.ts` | 35 | 9 | 1 | 78% |
| `eventstore/src/ServerSettings.ts` | 14 | 4 | 0 | 78% |
| `eventstore/src/spec/Spec.ts` | 69 | 14 | 4 | 79% |
| `commands/src/ExecutionResult.ts` | 4 | 0 | 1 | 80% |
| `eventstore/src/NotifyPayload.ts` | 109 | 22 | 3 | 81% |
| `event-poller/src/ProcessorManagementService.ts` | 46 | 10 | 0 | 82% |
| `commands/src/Event.ts` | 62 | 10 | 3 | 83% |
| `commands/src/testing/Scenario.ts` | 94 | 13 | 4 | 85% |
| `commands/src/testing/EventFixtures.ts` | 94 | 10 | 1 | 90% |
| `commands/src/Command.ts` | 26 | 3 | 0 | 90% |
| `event-poller/src/ProcessorRuntimeOverrides.ts` | 18 | 2 | 0 | 90% |
| `event-poller/src/EventSelection.ts` | 10 | 1 | 0 | 91% |
| `commands/src/Deadline.ts` | 27 | 2 | 0 | 93% |
| `event-poller/src/BackoffState.ts` | 16 | 1 | 0 | 94% |
| `event-poller/src/MonitorProcessors.ts` | 35 | 2 | 0 | 95% |
| `commands/src/Period.ts` | 38 | 1 | 1 | 95% |
| `eventstore/src/internal/WakeupNotifier.ts` | 45 | 2 | 0 | 96% |
| `commands/src/Contract.ts` | 1 | 0 | 0 | 100% |
| `event-poller/src/ProcessorConfig.ts` | 2 | 0 | 0 | 100% |
| `event-poller/src/internal/identifiers.ts` | 6 | 0 | 0 | 100% |
| `eventstore/src/Marker.ts` | 19 | 0 | 0 | 100% |
| `eventstore/src/Tag.ts` | 16 | 0 | 0 | 100% |


### 2. Triage the first report (the real work)

- Go through the survivors file by file, riskiest first (`eventstore` and `commands`, then `event-poller`). For each: a test that kills it, or `// Stryker disable next-line <mutator>: <reason>` for an equivalent one.
- Expect something like the pilot's rate (about one survivor in six) over a few thousand mutants, so hundreds of survivors, most of them quick. The budget is two to three days of work, spread over several commits, each closing one file.
- Starting points from the pilot: `Model.lifecycleQuery`, the type deduplication and `all({})` in `Model.ts`; the `useXid` guard and the negative-position check in `LogPosition.ts`; the same-key and no-key branches of the wake-up filter in `NotifyPayload.ts`.

Done when: every survivor in scope has a test or a marked reason, and the reasons can be read in one `grep`.

**Progress** (`grep -rn "Stryker disable" packages/*/src` lists every reason):

| File | Before | After | What it found |
|---|---|---|---|
| `eventstore/src/LogPosition.ts` | 59 % | 100 % | no test of a negative position, of a cursor with no transaction id or with `"0"` where the two orders disagree, nor of `latest` at all (what a repeat answered by its model points at, ADR-0034); one equivalent mutant marked |
| `commands/src/Model.ts` | 64 % | 100 % | `all(...)`'s result (prefix, boundary, guard, clock, members without fold or complete) was untested; so were a period's defects on an inconsistent or closed period, a closing of another period, an opening that lands between the two reads, the tracking of another entity's periods, and the period model's `lifecycleQuery` and `bindings` (the pilot's finding); `unionOf` took an `undefined` nobody passes; seven equivalent mutants marked |

| `eventstore/src/{AppendCondition,AppendEvent,CorrelationContext,EventDecoding,Query}.ts` | 17 to 50 % | 100 % | the builders and helpers had no test of their own (`Query.isEmpty`, `AppendCondition.idempotent` and `failIfChanged`, a build with no data, the fresh-transaction flag, an issue with no path, the decoding-failure count by event type); five that nothing in the repository used were deleted (`Query.queryItemOfTypes`, `queryItemOfTags`, `queryItemOfTag` and `empty`, the same as `noCondition`; `AppendEvent.hasTag`) |
| `eventstore/src/testing/InMemoryEventStore.ts` | 54 % | 94 % | a **real difference from Postgres**: a repeat caught by the trigger backstop (ADR-0035) was reported at the first event of the earlier append, Postgres reports its last (the marker the first run answered); fixed, and two conformance cases now check the `Duplicate`'s `latest`, `requests` and `byTrigger` on both stores. Also untested: a projection's projectors filtering by event type, the no-projector message, and a rollback of the backstop's keys. Two pieces of code that did nothing went (one key per event where only the first is read, a rollback of fingerprints that the next append overwrites); four equivalent mutants marked |

| `commands/src/Personal.ts` | 74 % | 100 % | a **bug**: `personalValues` did not collect a personal field at a tuple's position (`personalPaths` names it `0`, and the walk went only into objects), so the tag guard did not see it; also untested: a union member that comes later, tuples with and without a rest, a struct with a rest, an array where an object is expected, nulls on the way to a marked field. The AST nodes walked are typed by their tag, so the `?? []` that never ran went, and so did a `key in v` check that changed nothing |
| `commands/src/ModelImpact.ts` | 75 % | 100 % of what the unit tests reach | the report's text (counts, singular and plural, the advice line, the verdict) was not checked, nor the sorting of the baseline and of the event facts, nor the reason's length at its boundary; four equivalent mutants marked. `eventFactsFromLog` reads the database (tier 2) |
| `eventstore/src/Leader.ts` | 66 % | 100 % of what the unit tests reach | its failure paths had no unit test: a failed or silent statement on a shared session, the lease that cannot be set, a check that hangs, a pool with no connection, the heartbeat finding a lost lock by itself. A stand-in connection that fails or hangs on chosen statements, and checks each statement's parameters against its placeholders, now drives them. Two lines that cleared the current session went: the check at the start of an attempt (ADR-0046, the fix of #38) already does it, and is now the one place it happens; so did a flag reset that changed nothing. Eight equivalent mutants marked (belt and braces: a monitor that is interrupted and also stops by itself) |
| `event-poller/src/EventProcessor.ts` | 65 % | 100 % | the batch in one transaction (`atomically`) had no unit test at all, nor a cursor someone else moved, a progress table not there yet, a follower, a lock that cannot be asked for, a wake-up for other types, a failing stream of wake-ups, the poll metrics, or the backoff after a failure; one equivalent mutant marked |

| seven small files: `commands/src/{CommandDecision,Errors,Repeat}.ts`, `event-poller/src/ProgressCursor.ts`, `eventstore/src/{Listen,SessionClients,SharedListen}.ts` | 61 to 78 % | 100 % of what the unit tests reach | edges, no bug: the fingerprint pinned against SHA-256 of its canonical JSON (nested keys sorted, a bigint as digits), `isSameRequest`'s three rules, `kindOf` for each kind and for `null`, a symbol key in an input issue's path, the cursor order within one transaction, the LISTEN retry delay (it doubled, it never jumped to the maximum, it starts over after a lost connection), merged wake-ups with tag keys and a wildcard, the session clients a leader and a LISTEN use, the session-pool warning's text, a LISTEN connection that opened part-way. Code that did nothing went: a filter of empty wake-up batches (the debounce flushes none, and a test now says so), and a guard in `SharedListen`'s `drop` that always held; seven equivalent mutants marked. What opens a real connection (`sessionClientsLayer`, `sharedListen`) is tier 2 |

After these files tier 1 is at **92.0 %** (95.5 % of what the unit tests reach), from 72.4 %; `commands` 90.4 %, `eventstore` 92.5 %, `event-poller` 95.8 %.

**The sandbox hid mutants (found 2026-10-27).** Stryker runs in a copy of the repository and links each `node_modules` folder back to the original.
Each package's `node_modules` holds its sibling packages (`@crablet/eventstore` for `commands`), so in the copy a commands test imported the eventstore
source **unmutated**: an eventstore mutant that only the commands tests reach always survived. Mutating in place (`inPlace: true`) fixes it; on the
same code it moved tier 1 from 77.6 % to 79.1 % and `eventstore` from 72.2 % to 76.1 %. The baseline above was measured in the sandbox, so it is
lower than the code deserved there. Do not edit the sources while a run is going; Stryker restores them when it ends.

### 3. A ratchet for the score

- A baseline per package in a committed file (like `coverage-baseline.json`), a tolerance for run-to-run noise, and a check that fails when a package's mutation score falls below it.
- CI: **incremental** on pull requests (Stryker's incremental mode reuses the previous results and re-tests only mutants whose code or tests changed), the full run nightly or on demand. The incremental file is cached between runs.

Done when: a change that deletes a test of the core makes the mutation job fail, and a change that touches one file re-tests only that file's mutants.

**Done (2026-10-27), with CI changed: weekly and on demand, not on pull requests.**

- `scripts/mutation-gate.ts` reads Stryker's JSON report and compares each package, and tier 1 as a whole, with `tools/mutation/baseline.json` (tolerance 0.5 points). The score is
  Stryker's own (killed and timed out over those plus survived and not covered). `bun run mutation && bun run mutation:check` checks; `bun run mutation:baseline` raises the baseline
  and never lowers it (the coverage gate's `raise`); lowering it is a hand edit with the reason in the commit message.
- The baseline is the triage's result: tier 1 92.0, `commands` 90.3, `eventstore` 92.5, `event-poller` 95.7 (rounded down to a tenth).
- `.github/workflows/mutation.yml` runs tier 1 in full and the gate every Monday and by hand (`gh workflow run mutation.yml`), and keeps the HTML report as an artifact.
- **Why not on pull requests, for now.** A full run takes about 70 seconds locally, so speed is not the reason. Noise is: some tier 1 tests depend on real time (the LISTEN retry
  delays), and a mutant they kill on one run can survive the next; a gate that fails at random on pull requests stops being trusted. Stryker's incremental mode would also need its
  file cached from `main`, and it decides what to re-test per file, which is how the sandbox went wrong across packages. If the weekly job stays green for a few weeks, move the gate to
  pull requests (a full run, not incremental).
- Checked: with `event-poller/test/event-processor-paths.test.ts` removed, the gate fails (`event-poller` 76.7 % against 95.7 %, tier 1 88.8 % against 92.0 %); with it back, it passes.

### 4. Tier 2: the database-bound code, by list

- The 17 breaks of the coverage plan are kept in a script in the repository (`scripts/`), as data: file, text to find, text to put, the command that must fail. Run on demand and nightly, it is the regression test of the integration tests. Add to it whenever a bug is found in
  that code: the break that would have caused it.
- Optional, only if the list keeps finding gaps: Stryker's `command` runner over two or three files (`Leader.ts`, `PostgresProgressTracker.ts`, the SQL builders) at concurrency 4 and a few hundred mutants, nightly, not gated. The SQL of the migrations is not mutated by any tool; those mutants stay on the list.

Done when: the break list runs from one command, in CI nightly, and fails if any break survives.

### 5. Keep it honest

- A short section in `CONTRIBUTING.md`: how to run mutation testing on one file, how to read a survivor, and the rule that a disable comment needs a reason.
- The disable comments are counted in the CI log, so a growing pile is visible.
- Review the ratchet and the community plugin's health (releases, issues) after the first month.

## Risks and costs

- **Equivalent mutants** are the main cost, and cannot be avoided; the triage in step 2 and the reasons make it a one-time cost.
- **A single community maintainer** for the Bun runner. Pinned, with the `command` runner as the way out.
- **TypeScript 7.** Resolved only by isolation or by waiting; the spike in step 0 decides.
- **Flaky tests** become visible: a mutation run executes each test many times in separate processes. A flaky test shows up as an inconsistent survivor or a timeout. That is useful, but costs time.
- **CI time.** The pilot suggests minutes, not hours, for tier 1; the full core is expected to be a few thousand mutants. Measured in step 1, not assumed.
- **Gaming.** A mutation score can be raised by marking survivors as equivalent. The reasons are reviewed like code.

## How we will know

- Step 1 gives a baseline score per file, and the pilot's finding (`LogPosition.ts` 59 % at 100 % line coverage) is either confirmed or explained.
- After step 2, re-running the three survivors of the coverage plan's breaks (retries, `earliest`, the heartbeat) with the old tests removed shows them as survivors, so we know the tool would have found them.
- A new deliberate break in the core, not on the old list, is caught by the job.

## Decisions for the owner

1. Is a tier 1 run worth a few days of triage, given 99.7 % line coverage and 17 breaks already checked? (My view: yes for `eventstore`, `commands` and `event-poller`, because the three survivors were all in exactly this code; no for the rest.)
2. A community plugin by one maintainer, pinned, with a fallback: acceptable?
3. Where it runs: on every pull request that touches the core (incremental), nightly only, or on demand?
