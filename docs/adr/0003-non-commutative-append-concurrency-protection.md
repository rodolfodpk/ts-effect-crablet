# ADR-0003: Non-commutative append concurrency protection stays at the SQL layer

## Status

Accepted (Phase 0/1)

## Context

Under Postgres's default `READ_COMMITTED` isolation, two genuinely concurrent
`appendNonCommutative`-equivalent calls racing the same condition could **both succeed** —
verified empirically at ~93-95% double-success rate under real concurrent load, against both a
raw-SQL/`pg` harness and the actual predecessor `EventStoreImpl` (19/20 races both succeeded).
`append_events_if()`'s conflict check is snapshot-based (`transaction_id < pg_snapshot_xmin(...)`),
which can't see a peer transaction's row until that peer commits — a real gap between the
framework's documented guarantee ("Protection Mechanism: PostgreSQL snapshot isolation (MVCC)")
and actual behavior for genuinely-simultaneous (not staggered) races. This is a pre-existing bug in
The predecessor framework itself, not a TS-porting issue.

It was fixed in the SQL twice. First pass: `appendIf` bumped to `SERIALIZABLE` isolation
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
entirely on the predecessor-side SQL fix already landed in `append_events_if()` (the advisory-xact-lock),
which this repo's `internal/sql.ts` (Phase 1) reflects as-is — no isolation-level games needed on
the TS side.

## Consequences

- The SQL migrations in `packages/db-migrations/sql/` must be kept byte-for-byte in sync with
  the predecessor repo's `crablet-db-migrations`. They drifted once already: Phase 0's copied
  `V1__...sql` predated the predecessor-side lock fix, and Phase 1's first DCB-race test run silently
  reproduced the original bug (both concurrent appends succeeding) because the migration was
  stale, not because the TS client code was wrong.
- No tooling currently catches this cross-repo drift automatically — a checksum-comparison script
  or CI job is worth adding once both repos are actively developed in parallel.
- Because the protection lives entirely in the SQL function, the TS client is simpler (no
  isolation-level or transaction-mode branching) but is also fully dependent on the migration
  being current; a stale migration silently reintroduces the race with no compile-time signal.

## Addendum (Phase F): multi-item conditions, snapshot filter, per-item locks

Superseded in part by migration `V4__crablet_multi_item_append_conditions.sql`. The ADR above
describes protection that worked only for single-item conditions and only while no unrelated
transaction was open. Two independent defects were found by tests (both reproduced before the fix):

1. **Multi-item queries lost their OR semantics.** `append_events_if` took one flat
   `(event types, tags)` pair, and the client flattened every query item into it, so
   "(A and tag1) OR (B and tag2)" became "type in {A,B} AND has tag1 AND tag2". A conflicting event
   matching just one item was never detected, so any strict command with a multi-item decision model
   (the wallet's period-scoped Withdraw and Transfer) had no real protection against double-spend.
   Reads (`queryEvents`) were always correct; only the append condition was wrong. The earlier race
   tests used single-item queries, so they never saw it.
2. **The `transaction_id < pg_snapshot_xmin(...)` filter hid committed conflicts.** `xmin` is the
   oldest still-running transaction, so while any unrelated transaction was open (including a
   single-item condition), events committed after it started were excluded from the conflict check.

### Decision

- `append_events_if` now takes each condition as a JSONB array of `{types, tags}` items; an event
  matches an item when (types empty or type in types) AND (tags contain all item tags), and matches
  the condition when it matches any item. The client (`internal/sql.ts`) sends the items unflattened
  and drops items with neither types nor tags (no information); no items means no check.
- The `xmin` filter is removed. MVCC already hides uncommitted peer rows, and the advisory locks make
  committed peers visible because the check runs in a statement issued after the locks are taken (a
  fresh READ COMMITTED snapshot). Consequently **callers must run at READ COMMITTED**, the Postgres
  default; a caller-imposed REPEATABLE READ/SERIALIZABLE snapshot could predate a peer's commit.
  Events appended earlier in the *same* transaction and after the condition's position now count as
  conflicts (previously masked by the filter); no current command relies on that.
- Locks are per item (sorted keys, so acquisition is deadlock-free; idempotency locks always before
  concurrency locks) instead of one lock per whole condition. Commands whose conditions share an
  identical item serialize on it even if their other items differ: a wallet withdrawal and a transfer
  from the same wallet share the wallet's items. Verified: with whole-condition locks both racers won
  in 13 of 15 rounds; with per-item locks, 0 of 15.

### Known limitation in V4 - solved in V5

V4 serialized only writers that held a textually identical condition item. A writer with no condition, or
with different items, took no lock a checker could collide with, so its event could commit between the
checker's check and insert (a lost conflict). V5 (`V5__crablet_writer_side_locking.sql`) locks by
(event type, tag) pairs, taken by EVERY writer for its own events as well as for its conditions; an event that
matches a condition item always shares a pair with that item, so the two always queue. Tag-less and type-less
items fall back to exclusive type / global locks that every writer holds shared. The design follows the
documented approach of `@dcb-es/event-store`, whose code was read to confirm it.

Costs (measured, one run on a local container, 16 writers x 150 appends): appends to one hot (type, tag)
serialize - unconditional appends to a single wallet went from ~7.6k/s to ~2.6k/s; guarded ones from ~2.3k/s
to ~2.0k/s; appends to distinct wallets dropped 5-16%. Transactions that make several appends can now
deadlock with a mirror-image command (Postgres aborts one, SQLSTATE 40P01); the executor maps that to a
`Conflict` and re-runs the command. Tests: `append-writer-locking.test.ts` (an in-flight writer makes a
matching checker wait, then conflict; no false serialization) and `commands/test/integration/deadlock-retry.test.ts`.

Tests: `packages/eventstore/test/integration/append-multi-item.test.ts`.
