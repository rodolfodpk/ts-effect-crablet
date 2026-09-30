# ADR-0009: Build on Effect 4 (release candidate), pinned exactly

## Status

Accepted (Phase M)

## Context

The repo started on Effect 3.21 (`effect`, `@effect/sql`, `@effect/sql-pg`, `@effect/platform`,
`@effect/platform-node`, each versioned independently). Effect 4 unifies versioning across the
ecosystem and folds `@effect/sql` and `@effect/platform` into the core `effect` package. The API
redesign planned for this repo is a breaking rewrite of the low-level command/event-store surface
anyway, so migrating first avoids doing that work twice. Effect 4 is a release candidate
(`4.0.0-rc.118` when this was decided); npm has no separate LTS line.

## Decision

- Depend on `effect`, `@effect/sql-pg` and `@effect/platform-node` at the **same exact** version
  (`4.0.0-rc.118`); no ranges. Bump deliberately, all three together, and re-run the whole suite.
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
