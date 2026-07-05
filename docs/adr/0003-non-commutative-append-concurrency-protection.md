# ADR-0003: Non-commutative append concurrency protection stays at the SQL layer

## Status

Accepted (Phase 0/1)

## Context

Under Postgres's default `READ_COMMITTED` isolation, two genuinely concurrent
`appendNonCommutative`-equivalent calls racing the same condition could **both succeed** —
verified empirically at ~93-95% double-success rate under real concurrent load, against both a
raw-SQL/`pg` harness and the actual Java `EventStoreImpl` (19/20 races both succeeded).
`append_events_if()`'s conflict check is snapshot-based (`transaction_id < pg_snapshot_xmin(...)`),
which can't see a peer transaction's row until that peer commits — a real gap between the
framework's documented guarantee ("Protection Mechanism: PostgreSQL snapshot isolation (MVCC)")
and actual behavior for genuinely-simultaneous (not staggered) races. This is a pre-existing bug in
the Java framework itself, not a TS-porting issue.

It was fixed on the Java side twice. First pass: `appendIf` bumped to `SERIALIZABLE` isolation
when a concurrency condition was present, mapping SQLSTATE `40001` to `ConcurrencyException`
(~10% latency overhead). That was superseded because it only covered the standalone `appendIf`
path — `CommandExecutorImpl` (the real, command-handler-driven path almost all usage goes through)
calls `appendIfWithConnection`, which Postgres's "isolation level must be set before any query
runs in the transaction" rule made impossible to patch the same way. The actual fix moved
protection into `append_events_if()` itself: a second, distinctly-namespaced
`pg_advisory_xact_lock` (mirroring the existing idempotency lock) serializes the concurrency check
at the SQL layer, working uniformly regardless of caller isolation level, at lower overhead
(~4.7% vs ~10%).

## Decision

The TS client does no isolation-level control of its own for non-commutative appends. It relies
entirely on the Java-side SQL fix already landed in `append_events_if()` (the advisory-xact-lock),
which this repo's `internal/sql.ts` (Phase 1) reflects as-is — no isolation-level games needed on
the TS side.

## Consequences

- The SQL migrations in `packages/db-migrations/sql/` must be kept byte-for-byte in sync with
  `spring-crablet`'s `crablet-db-migrations`. They drifted once already: Phase 0's copied
  `V1__...sql` predated the Java-side lock fix, and Phase 1's first DCB-race test run silently
  reproduced the original bug (both concurrent appends succeeding) because the migration was
  stale, not because the TS client code was wrong.
- No tooling currently catches this cross-repo drift automatically — a checksum-comparison script
  or CI job is worth adding once both repos are actively developed in parallel.
- Because the protection lives entirely in the SQL function, the TS client is simpler (no
  isolation-level or transaction-mode branching) but is also fully dependent on the migration
  being current; a stale migration silently reintroduces the race with no compile-time signal.
