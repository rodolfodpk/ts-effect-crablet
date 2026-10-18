# Views and delivery: what reaches your handlers, and how often

*Concept · developers writing views, automations or outbox publishers · [tutorial step 4](../tutorial/04-read-your-own-writes.md) · 10 minutes*

Commands write events. Everything that *reacts* to events (views, automations, outbox publishers) reads the same log through a **poller**: a loop that
reads the events after its cursor, hands them to a handler, and moves the cursor. This page is what a handler can rely on, and what it must do itself.

## The guarantees

| Guarantee | What it means for your handler | How |
|---|---|---|
| **No event is skipped** | Every event your handler selects reaches it, even one whose transaction committed late. | The cursor is a `(transaction_id, position)` pair, not a bare position ([ADR-0012](../adr/0012-transaction-position-cursors.md)). |
| **At least once** | An event can arrive again after a crash or a change of leader. | A cursor moves after the handler, never before. |
| **Exactly once, for a view's own writes** | A view that writes through the `sql` its projector is given applies a repeated batch once. | The batch and the cursor commit in one transaction, and the cursor moves only if it is still where the batch started, so a repeated or overlapping batch is rolled back ([ADR-0023](../adr/0023-view-batch-and-cursor-in-one-transaction.md), [ADR-0032](../adr/0032-the-cursor-moves-only-from-where-its-batch-started.md)). |
| **In order** | Events arrive ordered by transaction, then by position. | The poller's query sorts on the same pair as the cursor. |
| **One handler at a time** | Only the module's leader runs your handler. A leader that lost its lock stops before it handles or moves a cursor. | See [background processors](./background-processors.md). |

## What you must do yourself

- **Make every other effect idempotent.** A projector's write outside the `sql` it is given, an automation's command and an outbox publication can each
  happen twice. An automation's command must declare `idempotentBy` (`automationHandlerOf` refuses one that does not). An outbox publisher should
  deduplicate on `event.position`.
- **Do not use "position is bigger than the last one I saw" as an idempotency check.** Delivery is ordered by transaction first, so a later event can
  have a smaller position.
- **Expect delay from long transactions.** A poller only reads events whose transaction is older than every transaction still open, which is what makes
  "no event is skipped" true. So a long-running transaction anywhere in the database holds delivery back until it ends.

## How a poller wakes up

A poller polls on an interval, and is also woken when something is appended: the event store sends one PostgreSQL `NOTIFY` per short window after the
commit, carrying the event types and tag keys appended ([ADR-0021](../adr/0021-wakeups-after-commit-and-coalesced.md)). A wake-up is only a hint. If
one is lost, the next poll finds the events, because the cursor, not the notification, decides what is delivered. The profiles and their measured
latency are in [Run it in production](../guides/operate/run-in-production.md#polling-and-wake-ups).

## Writing a view

A view is a table kept by a projector. You declare what each event does to its rows (adds, sets, removes) with `defineView`, or write plain SQL for
anything else ([ADR-0026](../adr/0026-views-declared-as-operations.md)). The migration stays the truth for the table, and a test compares the declaration
with the migrated database. The steps are in [Add a view](../guides/build/add-a-view.md).

Views update asynchronously, a moment after the write. How a reader still gets an answer that includes its own write is the next page:
[reading your own writes](./read-your-writes.md).

## Decisions behind this page

[ADR-0012](../adr/0012-transaction-position-cursors.md) (the cursor) · [ADR-0023](../adr/0023-view-batch-and-cursor-in-one-transaction.md) (a batch and its cursor in one transaction) ·
[ADR-0021](../adr/0021-wakeups-after-commit-and-coalesced.md) (wake-ups) · [ADR-0026](../adr/0026-views-declared-as-operations.md) (views as operations)
