# ADR-0033: Delivery order is causal order, and a command's append is its transaction's first write

## Status

**Accepted** (2026-10-18). Built: migration `V15__crablet_append_requires_fresh_transaction.sql` (`append_events_if` gains `p_require_fresh_transaction`),
`CorrelationContext.requireFreshTransaction`, set by `CommandExecutor` around each attempt, and `causal-order-postgres.test.ts`.

## Context

Pollers deliver events in `(transaction_id, position)` order (ADR-0012). That is neither commit order nor position order. The documents said "in order" without
saying which order, or whether a handler may rely on it.

What a handler needs is **causal order**: if a command read event A before it appended event B, every processor sees A before B. An automation that reacts to A
and the view that shows B both depend on it.

The order gives this as long as B's transaction gets its transaction id after it read A:

- A's transaction id was assigned before A committed, and B read A only after A committed;
- a transaction id is assigned at a transaction's first write, so if B's first write comes after its read, then `xid(A) < xid(B)`;
- advisory locks (the append's writer locks) do not assign a transaction id.

A command's transaction reads its model, then appends; `resolve` cannot write (ADR-0029), and the period turn is part of the same append (ADR-0025). So every
command satisfies the rule today, but **nothing checked it**. A command run inside an application's transaction that had already written would get its id before
reading, and its events could be delivered before their cause.

## Decision

- `append_events_if` takes `p_require_fresh_transaction` (default false). When it is true and `pg_current_xact_id_if_assigned()` is not null, it raises
  SQLSTATE `CRB01` before taking any lock: "a command must not run in a transaction that has already written".
- The command executor sets it for every attempt (`CorrelationContext.requireFreshTransaction`, read by `appendEventsIf`). `appendEventsIf` turns `CRB01` into a
  defect: it is a programming error, not a condition a caller can handle.
- A raw `EventStore.append` leaves it off. An application that appends twice in its own transaction (`deadlock-retry.test.ts` does) is not refused; the rule is
  for commands, whose decision reads first.
- The check is part of the existing call: no extra round trip.

## Consequences

- The guarantee is stated in [views and delivery](../concepts/views-and-delivery.md): delivery follows causality, and per processor events arrive in
  `(transaction_id, position)` order.
- What it does **not** order: events that did not read each other. Two commuting deposits can be delivered in either order relative to when they were decided.
  So a view's `add` is right in any order, while a `set` on a row that commuting events also write keeps the last one delivered, and a total that a
  commuting command recorded in its event is a snapshot that may be stale ([Add a view](../guides/build/add-a-view.md)).
- `causal-order-postgres.test.ts`: a command whose transaction opened before the event it reads committed still sorts after it; a command in a transaction that
  already wrote is refused and appends nothing.

## Alternatives considered

- **A separate `SELECT pg_current_xact_id_if_assigned()` at the start of the command's transaction.** The same check, one more round trip per command.
- **Order delivery by commit.** Postgres has no cheap commit sequence (`track_commit_timestamp` gives timestamps, not a total order, and costs a write per
  commit), and ADR-0012's cursor already guarantees that no event is skipped.
