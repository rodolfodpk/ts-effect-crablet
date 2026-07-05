# ADR-0006: Leader election via SqlClient.reserve + manually managed Scope

## Status

Accepted (Phase 0)

## Context

Advisory-lock-based leader election needs to hold a single Postgres connection open for as long
as a fiber holds leadership — mirroring Java's "never return to pool until released" pattern — and
release it either explicitly (on graceful stepdown) or implicitly (on connection drop/crash).
`SqlClient` exposes `reserve: Effect<Connection, SqlError, Scope>` as a public API for exactly this
kind of connection-holding use case, without dropping to a raw `pg.Client` escape hatch.

## Decision

Build leader election on `sql.reserve`, combined with manual `Scope.make()` / `Scope.extend()` /
`Scope.close()` to hold the connection open on success and close it immediately on failure.
`pg_try_advisory_lock` / `pg_advisory_unlock` run via `Connection.execute(...)` on the reserved
connection.

## Consequences

- Verified: exactly one winner across 20 concurrent-race iterations; a loser can reacquire after
  the winner releases.
- Known test gap, accepted as a simplification: no simulated hard crash (killing the connection
  without running `pg_advisory_unlock`) is covered — `leader.ts` doesn't expose raw connection
  access for that. Only the graceful release path is tested. A true crash-path test (relying on
  Postgres's own connection-drop cleanup) is a reasonable future addition, not yet built.
- Performance note carried forward from Phase 0: the 20-iteration concurrent-race test took ~21s
  (~1s/iteration), likely connection-acquisition overhead in `sql.reserve`'s pool interaction —
  not a correctness concern since leader election isn't a hot path, but worth profiling before
  assuming it scales to many concurrent processors.
