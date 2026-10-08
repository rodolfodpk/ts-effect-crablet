# Plan: mutation testing for the core packages

**Status:** proposed (2026-10-08), with a pilot done. Not started in the repository.

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

### 1. Tier 1: the pure and in-memory core, measured

- Scope: `packages/{eventstore,commands,event-poller}/src`, excluding files that only the integration tests exercise (they would all show as "no coverage" and mean nothing here): the list is generated from the merged coverage (files whose unit-only coverage is low).
- Configuration in `tools/mutation/`: unit tests selected with `bun.testFiles`, per-test coverage, `ignoreStatic`, the string-literal mutator switched off for SQL text and messages (they only produce equivalent noise), a JSON report, and an HTML report kept as a CI artifact.
- Output: the first score per file and per package, written into this plan as the baseline.

Done when: `bun run mutation` produces the report locally in minutes, and the baseline table is here.

### 2. Triage the first report (the real work)

- Go through the survivors file by file, riskiest first (`eventstore` and `commands`, then `event-poller`). For each: a test that kills it, or `// Stryker disable next-line <mutator>: <reason>` for an equivalent one.
- Expect something like the pilot's rate (about one survivor in six) over a few thousand mutants, so hundreds of survivors, most of them quick. The budget is two to three days of work, spread over several commits, each closing one file.
- Starting points from the pilot: `Model.lifecycleQuery`, the type deduplication and `all({})` in `Model.ts`; the `useXid` guard and the negative-position check in `LogPosition.ts`; the same-key and no-key branches of the wake-up filter in `NotifyPayload.ts`.

Done when: every survivor in scope has a test or a marked reason, and the reasons can be read in one `grep`.

### 3. A ratchet for the score

- A baseline per package in a committed file (like `coverage-baseline.json`), a tolerance for run-to-run noise, and a check that fails when a package's mutation score falls below it.
- CI: **incremental** on pull requests (Stryker's incremental mode reuses the previous results and re-tests only mutants whose code or tests changed), the full run nightly or on demand. The incremental file is cached between runs.

Done when: a change that deletes a test of the core makes the mutation job fail, and a change that touches one file re-tests only that file's mutants.

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
