# ADR-0004: Commit-time serialization failures are handled via Cause inspection, not typed errors

## Status

Accepted (Phase 0)

## Context

A `SERIALIZABLE` write-skew conflict is detected by Postgres at **COMMIT time** (error detail:
"Canceled on identification as a pivot, during commit attempt"). `@effect/sql`'s
`SqlClient.withTransaction` surfaces a commit-time failure as an **unrecoverable defect** (`Die`),
not a typed `SqlError` in the `E` channel — `Effect.catchTag("SqlError", ...)` does not see it.
This is a real, non-obvious gap between `@effect/sql`'s error-channel typing and what actually
happens at commit time, discovered while testing the (now superseded, see ADR-0003) SERIALIZABLE
isolation approach.

## Decision

Where a commit-time Postgres failure needs to be caught, use `Effect.catchAllCause` and walk the
`Cause` structure manually (checking `Die`'s defect for the Postgres error `code`, alongside the
normal `Fail` path) rather than relying on `Effect.catchTag("SqlError", ...)`.

## Consequences

- Any code path that might hit a commit-time Postgres failure needs to know it may arrive as
  either a `Fail` or a `Die`, and must inspect `Cause` accordingly — a plain `catchTag` is not
  sufficient and will let the failure escape as an unhandled defect.
- This is documented here specifically so future phases don't rediscover the same gap by trial and
  error when adding new transactional code paths that could hit similar commit-time conflicts.

## Addendum (Phase M, Effect 4): re-verified

Checked against a real Postgres on Effect 4 (`4.0.0-rc.118`; the suite still passes on `4.0.0`):

- A failure raised **at COMMIT** (forced deterministically with a `DEFERRABLE INITIALLY DEFERRED`
  unique constraint) still surfaces from `SqlClient.withTransaction` as a `Die` defect (whose value is
  an `SqlError`), not a typed failure. The decision stands.
- A `SERIALIZABLE` conflict detected *during a statement* ("Canceled on identification as a pivot,
  during write", SQLSTATE 40001) is now a **typed** `SqlError` with `reason._tag === "SerializationError"`.
  Only the commit-time variant needs the `Cause` walk.
- Inspecting a cause on v4: `Effect.catchCause` (was `catchAllCause`) and
  `cause.reasons.find(Cause.isDieReason)` / `Cause.isFailReason` (the recursive `Sequential`/`Parallel`
  cause shape is gone).

No code path currently depends on this (ADR-0003 no longer uses `SERIALIZABLE`).
