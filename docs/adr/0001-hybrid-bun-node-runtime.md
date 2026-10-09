# ADR-0001: Hybrid Bun + Node runtime

## Status

Accepted (Phase 0)

## Context

Bun (1.3.11) is the package manager and primary runtime for this monorepo. It runs pure-function
unit tests fine (`bun test`), but `@testcontainers/postgresql` hangs indefinitely under Bun: the
underlying Docker container starts and becomes healthy (confirmed via `docker ps`), but the
JS-side wait-strategy that confirms readiness never returns. An identical script completes in
1.83s under plain Node 25. The root cause was not investigated further (likely Bun's Node-compat
layer vs. testcontainers-node's log-stream-following internals) — this is a known, reproducible
blocker, not a config mistake.

## Decision

All Testcontainers-dependent tests (`append.test.ts`, `leader-election.test.ts`,
`listen-notify.test.ts`, and later integration suites) run via `node --test`, using Node's
built-in test runner — not Vitest, to keep dependencies minimal. Bun stays the package manager and
runtime for everything else (fast, in-memory unit tests, `bun install`, workspace tooling).

## Consequences

- Relative imports use `.ts` extensions directly (not the usual `.js`-in-source convention), since
  there's no build step — both Bun and Node resolve `.ts` extensions directly when running
  un-transpiled source.
- TypeScript files avoid constructor parameter-property shorthand (`constructor(readonly x: T)`)
  — that syntax needs real transformation, not mere type-stripping, and breaks Node's native TS
  execution.
- CI must install and use both runtimes: Bun for `typecheck`/`test:unit`, Node for
  `test:integration`. Node 24 (the version CI and `.nvmrc` pin; `engines` requires >=24) strips
  types by default, so `node --test` runs `.ts` files with no flag. (Node below 22.18/23.6 would
  need `--experimental-strip-types`; that flag was dropped from the scripts when the baseline
  moved to Node 24.)
- Two test runners means two slightly different assertion/mocking idioms in the same repo — an
  accepted ongoing cost of this split, not eliminated.

## Addendum (Phase M)

Re-checked with Bun 1.3.11 and Testcontainers 12.2: a Testcontainers-backed test file run with
`bun test` no longer hangs, but it fails with an error (not investigated), so the split stands:
integration tests run under Node, everything else under Bun. `@effect/sql-pg` 4.x no longer uses
node-postgres, so Postgres-backed code paths do not depend on `pg` at runtime.

## Update (2026-10-08): retried on Bun 1.4.2, the decision stands

The hang above was found on Bun 1.3.11 and Node 25. On Bun 1.4.2 (the latest at the time) it **did not reproduce**: a Testcontainers test started its Postgres in 21 s and passed, and 15 of 16 tests in three heavier files (LISTEN/NOTIFY, the multi-instance wallet suite with advisory locks and failover, the event processor) passed under `bun test`; the one failure was a flaky test that also failed under Node and was fixed (it read its results before the listener had finished recording them).

The decision does not change, for other reasons found in the same trial:

- **Sequential is slow.** `bun test` runs the files one at a time: after 7 minutes it had reached 27 of 73 integration files (no failures so far), against about 2 minutes for the whole suite under Node with `--test-concurrency=4`. I stopped it there; **no full run under Bun was completed**.
- **`bun test --parallel=4` did not help.** The first files failed in `before` with a 60 s timeout (starting four Postgres containers at once, behind the lock in `startTestDb`), and the pace stayed at about 4 to 6 files a minute. I stopped it too.
- A hang may well have been fixed in Bun between 1.3.11 and 1.4.2, but nothing here needs it: the integration tests run on Node, in CI as well.

