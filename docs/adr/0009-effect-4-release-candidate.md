# ADR-0009: Build on Effect 4, pinned exactly

## Status

Accepted (Phase M). Updated 2026-10-01: Effect 4.0.0 is released and the repo moved from `4.0.0-rc.118` to `4.0.0` (see the addendum at the end).

## Context

The repo started on Effect 3.21 (`effect`, `@effect/sql`, `@effect/sql-pg`, `@effect/platform`,
`@effect/platform-node`, each versioned independently). Effect 4 unifies versioning across the
ecosystem and folds `@effect/sql` and `@effect/platform` into the core `effect` package. The API
redesign planned for this repo is a breaking rewrite of the low-level command/event-store surface
anyway, so migrating first avoids doing that work twice. Effect 4 is a release candidate
(`4.0.0-rc.118` when this was decided; `4.0.0` shipped later, see the addendum); npm has no separate LTS line.

## Decision

- Depend on `effect`, `@effect/sql-pg` and `@effect/platform-node` at the **same exact** version
  (`4.0.0`; it was `4.0.0-rc.118` until the stable release); no ranges. Bump deliberately, all three together, and re-run the whole suite.
- Import SQL from `effect/sql`, HTTP from `effect/http` and `effect/http-api`. The migration guide
  written for the beta shows an `effect/unstable/*` prefix; in this release candidate the modules
  live at those unprefixed paths (check `node_modules/effect/package.json` `exports`).
- Write new code against the v4 idioms (`Context.Service`, `Context.Reference`, `Effect.catch`,
  `Effect.forkDetach`, ...). No compatibility layer for v3.

## What changed for this codebase (and is not obvious from the types)

- **`@effect/sql-pg` no longer wraps node-postgres.** It ships its own wire-protocol client with a
  binary type registry. Consequences: (1) columns with no registered codec fail to decode - `xid8`
  (`transaction_id`) is read as text (`transaction_id::text`), with `ORDER BY` on the *qualified*
  column so it still sorts by the real xid8; (2) `int8` comes back as `bigint`, not a string;
  (3) `pg` remains a dependency only where a raw client is used directly (`test-support`, the wallet
  example's migration runner, and two tests).
- **`SqlError` is nested.** The Postgres error (with SQLSTATE `code`) is `error.reason.cause`;
  detection of "undefined table" (42P01) reads it there.
- **`PgClient.listen` returns an Effect yielding a queue**, consumed with
  `Stream.unwrap(Effect.map(listen, Stream.fromQueue))`; `Stream.groupedWithin` yields arrays, not
  `Chunk`s. `PgClient.notify` now works for dynamic payloads (see ADR-0005).
- **HttpApi was redesigned.** Endpoints take an options object (`params`, `query`, `payload`,
  `success`, `error`); a status is attached to an error class with the `{ httpApiStatus: N }`
  annotation (a plain `Schema.Class` still encodes to exactly its fields, no `_tag`); handlers are
  registered with `HttpApiBuilder.group(api, name, handlers => Effect.succeed(handlers.handle(...)))`,
  the routes with `HttpApiBuilder.layer(api)`, and served with `HttpRouter.serve(routes)`. Returning
  a raw `HttpServerResponse` (chosen status and headers) still bypasses success encoding.
- `Metric`: three type parameters became two; `tagged` -> `withAttributes`, and `increment`,
  `incrementBy`, `set` are all `Metric.update`. `FiberRef` -> `Context.Reference` (correlation
  ids). `Cause` is a flat list of `reasons`. `Effect.yieldNow` is a value, not a function.
  `TestClock` lives in `effect/testing`. `Schema.decodeUnknown` -> `decodeUnknownEffect`; parse
  failures are `SchemaError`.

## Consequences

- A release-candidate dependency can change between candidates. Exact pinning plus the full
  integration suite (real Postgres, real HTTP) is the safety net; upgrade on purpose, not by range.
- ADR-0004, ADR-0005 and ADR-0006 were each re-verified on v4 and carry an addendum.
- The `pg` package is no longer a transitive requirement of the Effect SQL layer, so a deployment
  needs it only for tooling that uses a raw client.

## Addendum (2026-10-01): moved to 4.0.0

`effect`, `@effect/sql-pg` and `@effect/platform-node` (and `@effect/platform-browser`) were published at `4.0.0`, now the npm `latest`
tag. The bump was tried first in a throwaway worktree and then applied: every `package.json` pin changed from `4.0.0-rc.118` to `4.0.0`, with no
code change. Typecheck clean, 300 unit and 202 integration tests green (the integration suite twice), and the generated OpenAPI
descriptions in `docs/api/` are byte-identical. The imports named above (`effect/sql`, `effect/http`, `effect/http-api`) are unchanged in the
stable release. ADR-0004 and ADR-0005 were verified on rc.118 and their behaviour held on 4.0.0 (the whole suite exercises both). The rule stands:
bump all Effect packages together, exact versions, full suite.

## Addendum (2026-10-09): moved to 4.0.2

`effect`, `@effect/sql-pg`, `@effect/platform-node` and `@effect/platform-browser` went from `4.0.0` to `4.0.2` (the npm `latest`; Foldkit from 0.165.0 to 0.167.0 in the three UIs). Two things needed a change, both in tests:

- **The derived HTTP client's methods are generic over a response mode** (`decoded-only`, `response-only`, `decoded-and-response`). `ReturnType` of a generic function uses the constraint, so the type-level contract test (`contract-api.types.ts`) saw the union of all three modes; it now instantiates the default mode first. Runtime and the generated OpenAPI descriptions are unchanged.
- **Closing a pool now waits for the connections still reserved from it.** Two leader tests built a layer around each call, so the pool was closed while the leader still held its connection, and the call never returned. They now share one `ManagedRuntime` per file and release what they take (`leader-election.test.ts`, `leader-liveness.test.ts`). Nothing in the application changed: every module releases its leader before its client goes (the wallet's end-to-end tests stop an instance under load and pass).

Typecheck clean, 838 unit and 394 integration tests green. ADR-0024's findings (pool of 7 or more, listen reserving a pooled connection) were rechecked on 4.0.2 by `session-clients.test.ts` and `pgbouncer-e2e.test.ts`, both in that run.

