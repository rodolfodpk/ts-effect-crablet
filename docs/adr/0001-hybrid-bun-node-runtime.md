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
  `test:integration`. On Node versions below 23.6, `node --test` needs the explicit
  `--experimental-strip-types` flag to execute `.ts` files at all (harmless to pass on newer Node
  versions where it's already default-on).
- Two test runners means two slightly different assertion/mocking idioms in the same repo — an
  accepted ongoing cost of this split, not eliminated.
