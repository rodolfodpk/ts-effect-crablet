# ADR-0012: Cursors are (transaction_id, position) pairs, not bare positions

## Status

Accepted

## Context

`crablet_events.position` is assigned by `nextval()` when a row is inserted. `transaction_id` is the xid of the inserting
transaction (`append_events_batch` takes it with `pg_current_xact_id()`, then each row's position comes from the sequence).
The two are taken at different moments, so their orders can disagree: transaction T1 can get the LOWER xid and the HIGHER
position, transaction T2 the reverse, and T1 can commit while T2 is still open.

Two places used a bare position as a cursor, and both could lose information that way:

- **The pollers** (views, outbox, automations) fetched `position > cursor AND transaction_id < xmin ORDER BY position`. The xmin
  bound only says the rows below xmin are final, not that no row with a lower position is still to come. With T1 committed and T2
  open, xmin is T2's xid, T1's row is visible, the cursor moves to T1's (higher) position, and T2's row, when it commits, is behind
  the cursor for ever. A stress test (16 writers x 1500 appends) lost 11-22 events per run (0.05-0.09%); the same loop keyed on
  `(transaction_id, position)` lost none of 72,000. Nothing signalled the loss.
- **The append condition** (`append_events_if`) refused an append when a matching event had `position > afterPosition`, where
  `afterPosition` is the last event the model loaded. A command that loaded between T1 and T2 took T1's position as its cursor, so T2's
  event (committed before the append, in the boundary, never seen) was not a conflict: a lost conflict, i.e. a consistency bug. Writers
  lock their own `(type, tag)` pairs, so writers of different event types of one boundary (a deposit and a withdrawal on one wallet)
  do not serialize, and the model load takes no lock.

## Decision

A cursor is a point in `(transaction_id, position)` order (`ProgressCursor` in `@crablet/event-poller`; `LogPosition` in the event store).
That is the order model loads already use (`ORDER BY transaction_id, position`), and the index `(transaction_id, position)` exists.

- **Safety argument.** Every transaction with an xid below the snapshot's xmin has finished. A row that becomes visible later therefore has an
  xid at or above that xmin, which is greater than the xid of any row already read, so it sorts after the cursor.
- **Pollers.** `fetchEvents` takes the cursor; the query is `(transaction_id, position) > cursor AND transaction_id < xmin ORDER BY transaction_id,
  position`. The progress tables gained `last_transaction_id` (V8; `last_position` stays for lag and operations). `V8` backfills it with the
  smaller of the xid at `last_position` and the smallest xid among later events, so an event the old cursor had not delivered is never put behind
  the new one (it may redeliver a few; handlers are at-least-once).
- **Waiting.** `waitUntilProcessed` and `ViewWaiter` (removed by ADR-0015; the read wrapper in `@crablet/views-http` calls `waitUntilProcessed`) take the write as a `(transactionId, position)` pair (`ExecutionResult.lastTransactionId`),
  and compare pairs: a view's cursor can be at a higher position than a write and still not have processed it. HTTP responses keep `lastPosition`.
- **Append condition (V7).** `append_events_if` takes `p_after_cursor_transaction_id` and compares pairs. The model load returns, as its cursor,
  the pair of the last loaded event that was already SETTLED when it read (`transaction_id < pg_snapshot_xmin`), and ignores the caller's own
  transaction in the check (a command's `prepare` appends are part of what it loaded). A loaded-but-unsettled event stays above the cursor and is
  reported as a conflict; the command retries and reloads it settled.

## Consequences

- **No skipped events, no lost conflicts** for the reproduced cases (deterministic integration tests for the poller, the append condition, and the
  wait comparison, plus a concurrent-writers smoke test).
- **Delivery order changes slightly.** Across transactions, events are delivered in xid order rather than strict position order (within a
  transaction, position order). Causality is preserved when a transaction writes nothing before it reads (its xid is assigned at its first write);
  a command whose `prepare` appends before the model loads gets its xid early, so its events can be delivered before those of a transaction it later
  read. The guarantee is per-boundary consistency (the DCB condition), not a global causal delivery order.
- **An occasional extra `Conflict`.** An event that a command loaded while an older transaction was still open counts as a conflict at the append;
  the retry settles it. Rare, and a retry fixes it.
- **Breaking interface change** (packages are unpublished, so no shim): `EventFetcher.fetchEvents(id, cursor, n)`,
  `ProgressTracker.getCursor/updateCursor`, `waitUntilProcessed(subscription, write, ...)`, `ViewWaiter(write, ...)` (since removed, ADR-0015).
- **Unchanged limits.** The xmin bound still makes every poller wait for ANY open transaction in the database, including unrelated ones (an
  idle-in-transaction session stalls delivery): alert on long-running transactions. Handlers stay at-least-once and must be idempotent.
- **Events already skipped before this fix** cannot be found automatically. To recover, reset the processor's progress row to zero
  (`last_position = 0, last_transaction_id = '0'`) and let it re-deliver.
