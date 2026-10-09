# ADR-0023: A view's batch and its cursor commit in one transaction, so a repeated batch is applied once

## Status

**Accepted** (2026-10-09). Built for views (`EventProcessorDeps.atomically`, `ProgressTracker.advanceCursor`, tests in `packages/views/test/integration/view-exactly-once.test.ts`). Not applied to automations or
the outbox; "Alternatives" says why. The cost figures are from one run on a local Postgres in Docker, not from AWS.

## Context

A poller handled a batch and then moved its cursor, in two steps and two transactions (`EventProcessor.ts`: `handler.handle`, then `progressTracker.updateCursor`). A batch can therefore be handled twice:

- the process dies between the view's commit and the cursor's update, and the retry handles the batch again;
- a leader that lost its lock (a zombie) and its successor take the same batch at the same time. The fence (`leader.verify` before the handler and before the cursor moves) narrows this and does not close it: it checks, then acts.

For a view that **adds** (the wallet's balance and summary views do: `balance = balance + $1`, `total_deposits = total_deposits + ...`) a repeated batch doubles the numbers. **Measured** on Postgres, with the wallet's
projectors and one batch of three events handled twice: the balance went from 107 to 114, and the deposit and withdrawal totals from 10 and 3 to 20 and 6. The transaction view, which inserts with
`ON CONFLICT DO NOTHING`, did not change. The forward-only cursor (ADR-0012, `WHERE (last_transaction_id, last_position) < (new)`) stops a zombie from moving the cursor back; it does nothing about the
batch the zombie was in.

## Decision

For views, the handler's writes and the cursor move go in **one transaction**, and the cursor move is a compare-and-set:

- `EventProcessorDeps.atomically` (views pass `sql.withTransaction`) wraps `handle` and `advanceCursor`. `ProgressTracker.advanceCursor` is `updateCursor` that returns whether a row moved (`RETURNING 1`).
- When it moves nothing, another processor already took this batch: the transaction is rolled back, and with it every write the handler made. The tick returns 0 and logs a warning. Under READ COMMITTED the
  second `UPDATE` waits for the first's commit, re-reads the row, finds the cursor already past, and matches nothing; that is the standard Postgres behaviour and the test forces the overlap with a latch.
- The handler's error is recorded **after** the rollback (inside the transaction the record would be undone with it), and only a handler failure counts toward `maxErrors`. A failed cursor move does not.
- The view-progress ping (`pg_notify`, ADR-0014) is in the cursor statement, so it is now delivered with the commit of the view's data and the cursor together.
- It is opt-in per processor. Without `atomically`, or with a tracker that has no `advanceCursor`, the old two steps are used unchanged.

## Result

- `view-exactly-once.test.ts`: a control, two processors on the same batch, and a crash between the view's commit and the cursor (a trigger makes the cursor update fail). The last two fail without the change
  (24 instead of 12) and pass with it.
- Cost, a local Postgres, a projector with one `UPDATE` per event, order alternated so drift cancels: one event per tick **+0.26 ms** (2.44 to 2.70 ms); draining 5,000 events in batches of 100, no difference
  (about 4,300 to 4,800 events/s before, 4,700 to 5,000 after). The extra work is a savepoint (the projector's own `withTransaction` now nests) and the longer transaction. **Not measured on AWS**, where
  every round trip costs more.

## Consequences

- **Only writes through the `sql` the projector is given are covered** (`makeTransactionalViewProjector` passes it). A projector that writes to another database or calls a service is still at-least-once and
  must be idempotent. The guides say so.
- The view's transaction already held an xid; it now also touches the progress row at its end, a row that the same processor updated anyway.
- A batch that keeps failing is retried whole, as before: the rollback undoes the part that had succeeded.

## Alternatives considered

- **The same for automations.** Tried: a batch of commands plus the cursor in one transaction fails on `idx_crablet_commands_transaction_id`, a unique index on the command audit's `transaction_id`. The audit
  assumes one command per transaction (it links a command to its events by that id), and a batch is many. The workable form is one transaction per decision, which is the next item.
- **A record of what each automation did per trigger event** (a table keyed by automation, trigger position, command and a hash of the input, written in the decision's transaction). Built as a spike
  (branch `spike/automation-effects`) and it works: the six scenarios pass, including a race and conflicts retried inside the transaction. Two findings: the record must be written **after** the command,
  because an early write gives the transaction its xid and holds back the horizon the command's own load reads up to, so a strict command conflicted on every retry; and a `withWakeups` inside another must join
  it, or the wake-up is sent before the outer commit. The cost is the reason it was not adopted: **+0.82 ms per decision (+26%) and draining 1,000 decisions fell from about 800 to 500 per second**.
  With `idempotentBy` kept (below) it adds only protection against a key too narrow, and it cannot undo a key too broad, because `idempotentBy` decides first.
- **Automations keep `idempotentBy`, now required** (`automationHandlerOf` throws for a command without it) and checked by a test the author calls (`assertAutomationIdempotent`, with no database; its verdicts are
  compared with real Postgres by `automation-idempotency-postgres.test.ts`). It cannot choose the key for the author: a key too broad drops work in silence, and the test only sees it with triggers that share the key.
- **The outbox stays at-least-once.** Its effect is outside the database and a rollback cannot undo it; a repeat is accepted, and the publisher contract says to deduplicate on `event.position`.
- **Make every view idempotent by itself** (a last-applied position per row). Rejected: the cursor orders by `(transaction_id, position)`, and position alone does not follow that order, so "ignore anything at or
  below the last position" could drop a legitimate event; and it moves the work into every view.
