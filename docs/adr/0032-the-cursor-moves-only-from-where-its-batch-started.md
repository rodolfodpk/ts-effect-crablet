# ADR-0032: A cursor moves only from where its batch started

## Status

**Accepted** (2026-10-18). Built: `ProgressTracker.updateCursor` and `advanceCursor` take `(id, from, to)`, in `PostgresProgressTracker`, `OutboxProgressTracker`
and the in-memory test double; `EventProcessor` passes the cursor it read. Amends [ADR-0023](0023-view-batch-and-cursor-in-one-transaction.md), whose
compare-and-set was forward-only.

## Context

ADR-0023 made a view's writes and its cursor commit in one transaction, and rolled the transaction back when the cursor update moved no row. The update's condition
was "the stored cursor is behind the new one" (`(last_transaction_id, last_position) < (new)`). That stops a repeat of the **same** batch. It does not stop two batches
that **overlap**:

- a zombie leader and its successor both read cursor C;
- the zombie fetches `[e1]` and the successor `[e1, e2]`. Two fetches from the same cursor can end in different places, because the `xmin` bound has moved between
  them (ADR-0012), or because the two instances run with a different `batchSize`;
- the zombie commits first, and the cursor is at `e1`;
- the successor's condition holds (`e1 < e2`), so it commits too, and `e1` is applied twice.

**Measured** (`view-exactly-once.test.ts`, "OVERLAPPING batches", with the smaller batch forced to commit first): an adding view counted 17 for the events 5 and 7.
The test written for ADR-0023 gave both processors the same batch, so it never saw this.

## Decision

A cursor moves only if it is still where the batch started: `WHERE (last_transaction_id, last_position) = (from)`. The processor passes the cursor it read
before fetching, as `from`.

- **Views (atomic path).** The successor's update matches no row (the cursor is no longer `C`), its transaction is rolled back with its writes, and the next tick
  fetches from where the zombie stopped. Under READ COMMITTED, the second `UPDATE` waits for the first to commit, then re-reads the row and re-checks the condition.
  Which of the two commits first no longer matters.
- **Outbox and automations (non-atomic path).** The same condition applies. Their effects are already done when the cursor moves, so a cursor that did not move only
  means the batch was handled twice, which at-least-once allows. It is logged as a warning, not an error.
- The rule is the same for every processor, so there is one rule to reason about. A zombie's late write changes nothing whether it is behind or ahead of the
  stored cursor.

## Consequences

- A view applies each event once even when batches overlap. The guarantee in [views and delivery](../concepts/views-and-delivery.md) is now true as written.
- No extra statement: the condition is part of the update that was already there.
- The cursor columns are `NOT NULL DEFAULT '0'` (V8), so the equality is never compared with a NULL.
- Anything that moves a cursor must know where it was. Inside the framework only the processor moves cursors; the management service resets the error count and
  the status, never the cursor.

## Alternatives considered

- **Read the cursor and fetch inside the transaction, with `SELECT … FOR UPDATE` on the progress row.** It serializes the two processors up front instead of rolling
  one back. Rejected: the row lock gives the view's transaction a transaction id before the fetch, so the fetch's `xmin` bound cannot pass the view's own
  transaction. Each batch would then trail the log by one, and the transaction would hold a lock on the progress row for the whole batch.
- **Keep the forward-only check and make batches deterministic.** Not possible: the `xmin` bound depends on what else is running when the fetch happens.
