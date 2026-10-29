# ADR-0048: A conflict is what the read did not see

## Status

**Accepted** (2026-10-29). Built: the read's snapshot (`ProjectionResult.seen`, `@crablet/eventstore/ReadSnapshot`), carried by the commands into the
append condition (`AppendCondition.seen`), and checked by the append (`V6__crablet_append_sees_the_read.sql`). Refines the append condition of
ADR-0012; the pollers are unchanged.

## Context

A condition's cursor is the last **settled** event its read loaded: one whose transaction id is below the snapshot's xmin, the oldest transaction still
running (ADR-0012). A loaded event above that is reported as a conflict, and the command is retried "with it settled". The cursor of `all(...)`, of a
model with a period and of a command with `resolve` is the read's horizon, `(xmin, 0)` (ADR-0018, decision 8), with the same effect.

That retry assumes the event settles soon. It does not while any transaction anywhere in the database stays open: xmin stays below everything written
after that transaction began, so every such event stays above the cursor, and the immediate retries meet the same xmin. Reproduced deterministically: a
session takes an xid and waits; another commits two `AccountOpened`; a `Transfer` between those accounts fails with `Conflict` at all four attempts,
though nothing else wrote to them. The likely cause of the flaky `monthly-fee` race test in CI (an `IssueInvoice` with no other writer refused four
times while the views processor's batch was open), and in production: a slow batch, a job, an idle-in-transaction session makes the commands over
recent events fail for as long as it lasts. ADR-0012 recorded the xmin limit for the pollers only.

The DCB specification asks for less: the store "MUST ignore the Events before the specified position", `after` being "the highest position the client
was aware of while building the Decision Model". An event the read saw is not a change since the read, settled or not. Taking the newest event loaded
as the cursor is not safe here: positions and transaction ids are taken in different orders (ADR-0012), so an event committed after the read can sort
below it.

## Decision

1. **A read carries the snapshot it was taken in.** `project` takes `pg_current_snapshot()` just before its query, where it took xmin before, and returns
   it as `ProjectionResult.seen`; the horizon's xmin comes from the same snapshot. Taken BEFORE the read, it never sees more than the read did. The
   in-memory store carries none (its reads are serial, and its position cursor exact).
2. **The append counts as a conflict only what that snapshot could not see.** `crablet_items_match_any` and `append_events_if` take it as a last
   parameter, `p_after_snapshot`, with a default: a matching event after the cursor, not of the caller's own transaction, is a conflict only if its
   transaction id is from the snapshot's xmax on or was running when it was taken (`NOT pg_visible_in_snapshot`, written that way so the scan skips the
   visible ones). Without a snapshot, the check is as before.
3. **No conflict is lost.** An event committed after the read was, when the snapshot was taken, running (in xip) or not started (from xmax on): it is
   not visible, so still a conflict. It is also above the cursor (the last settled event has an xid below xmin; the horizon is `(xmin, 0)` of the same
   snapshot, and an unseen event has an xid of at least xmin and a position of at least 1), so the cursor, kept as the scan's bound, never drops it.
   Commits of peers while the append waits for its locks are seen by the check, as before (ADR-0003).
4. **Several reads: what all of them saw.** `all(...)`, a period's turn and `resolve` combine their reads' snapshots by intersection
   (`ReadSnapshot.intersect`: the smaller xmin and xmax, the running ones of both): an event one of the reads could not see stays a conflict. A read
   without a snapshot makes the whole carry none, which is the behaviour from before, never a missed conflict.
5. **Only the commands use it.** `AppendCondition` gains an optional `seen`; `AppendCondition.of` and `failIfChanged(...).after(...)` do not take one, so
   code that uses the event store directly keeps the old check. `ReadSnapshot` is opaque and its functions are an internal entry point.
6. **A new migration, V6** (ADR-0047, rule 5): it drops the two functions and creates them again, with V2's bodies and the snapshot added.
   `append_events_batch` and the lock helpers stay in V2.

## Consequences

- An open transaction unrelated to a command no longer makes it fail or retry (`long-transaction-postgres.test.ts`: one model, `all(...)`, `resolve`).
  The pollers still wait for it (ADR-0012), and so do reads with `consistentWith`, which wait for a view.
- Fewer retries without a long transaction too: any writer with a lower xid, open at the moment of a load, made the boundary's fresh events conflicts.
- What stays conservative: an event committed between the snapshot and the read's own statement (a commit in microseconds) is a conflict though the read
  saw it; between the members of `all(...)`, one seen by one member and not by another is a conflict for both. Both existed before, wider, and the retry
  converges. Taking the snapshot inside the read's own query would remove the first and a round trip; not done here.
- The append is in two files again (V2 and V6), against ADR-0047's wish; it is what its rule 5 costs.
- Breaks (`scripts/breaks.ts`): the snapshot not passed, the transactions from xmax on treated as seen, the running ones treated as seen, an intersection
  that keeps only the last read. Tests: the regression above; the snapshot against Postgres (`read-snapshot.test.ts`: the append's test agrees with
  `pg_visible_in_snapshot`, an intersection is read by Postgres and sees what both see); the intersection against its sets
  (`packages/eventstore/test/read-snapshot.test.ts`).
