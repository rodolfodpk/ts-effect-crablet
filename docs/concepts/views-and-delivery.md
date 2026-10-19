# Views and delivery: what reaches your handlers, and how often

*Concept · developers writing views, automations or outbox publishers · [tutorial step 4](../tutorial/04-read-your-own-writes.md) · 10 minutes*

Commands write events. Everything that *reacts* to events (views, automations, outbox publishers) reads the same log through a **poller**: a loop that
reads the events after its cursor, hands them to a handler, and moves the cursor. This page is what a handler can rely on, and what it must do itself.

## The guarantees

| Guarantee | What it means for your handler | How |
|---|---|---|
| **No event is skipped** | Every event your handler selects reaches it, even one whose transaction committed late. | The cursor is a `(transaction_id, position)` pair, not a bare position ([ADR-0012](../adr/0012-transaction-position-cursors.md)). |
| **At least once** | An event can arrive again after a crash or a change of leader. | A cursor moves after the handler, never before. |
| **In causal order** | Events arrive ordered by transaction, then by position. An event arrives after every event the command that appended it had read. | The poller's query sorts on the same pair as the cursor, and a command's append is its transaction's first write, so it gets its transaction id after its reads ([ADR-0033](../adr/0033-delivery-order-is-causal-order.md)). |
| **One leader at a time, fenced by the cursor** | Only the module's leader runs your handler. A leader checks its lock before it handles and before it moves the cursor, but a check is not a fence: a leader that loses its lock between the check and the work can still do that work once. The cursor is the fence: it moves only from where the batch started, so a zombie's late move changes nothing. | [Background processors](./background-processors.md), [ADR-0032](../adr/0032-the-cursor-moves-only-from-where-its-batch-started.md). |

What that means for each kind of handler:

| Handler | A repeated or overlapping batch | Why |
|---|---|---|
| **View** (writes through the `sql` its projector is given) | **Applied once.** | The batch and the cursor commit in one transaction, and the cursor moves only if it is still where the batch started; otherwise the whole batch is rolled back ([ADR-0023](../adr/0023-view-batch-and-cursor-in-one-transaction.md), [ADR-0032](../adr/0032-the-cursor-moves-only-from-where-its-batch-started.md)). |
| **Automation** | **Its command runs again, and appends nothing again.** | The command's `idempotentBy` recognises the repeat ([ADR-0034](../adr/0034-a-repeat-must-be-the-same-request.md)); behind it, the database refuses the same trigger appending the same request twice ([ADR-0035](../adr/0035-the-same-trigger-cannot-append-the-same-request-twice.md)). |
| **Outbox publisher** | **Published again** (at least once). | Its effect is outside the database. Each event carries a stable `eventId` for the destination to deduplicate by; a publish has a time limit; a publisher that sends one event at a time keeps what it sent when a later one fails ([ADR-0036](../adr/0036-outbox-delivery-event-id-timeout-and-partial-progress.md)). |
| **A projector's write anywhere else** (another database, a service) | **Done again.** | Nothing can roll it back: make it idempotent. |

The live-update ping a view sends after its cursor moves, and the wake-up a poller gets after an append, are **at most once**: hints, never the source of
truth ([ADR-0014](../adr/0014-live-updates-by-ping.md), [ADR-0021](../adr/0021-wakeups-after-commit-and-coalesced.md)). A command repeated by its client is
"already done", with the earlier write's marker, or refused if the same id carries a different request ([ADR-0034](../adr/0034-a-repeat-must-be-the-same-request.md)).

## What you must do yourself

- **Make every other effect idempotent.** A projector's write outside the `sql` it is given, an automation's command and an outbox publication can each
  happen twice. An automation's command must declare `idempotentBy` (`defineAutomation` refuses one that does not); behind it, the database refuses the
  same trigger appending the same request twice ([ADR-0035](../adr/0035-the-same-trigger-cannot-append-the-same-request-twice.md)). An outbox publisher gives
  the destination `event.eventId` as the message id, so a broker that deduplicates by id drops a repeat; a consumer that keeps the order can instead skip
  anything at or below the last `(transactionId, position)` it applied ([ADR-0036](../adr/0036-outbox-delivery-event-id-timeout-and-partial-progress.md)).
- **Do not use "position is bigger than the last one I saw" as an idempotency check.** Delivery is ordered by transaction first, so a later event can
  have a smaller position. The pair `(transactionId, position)` is the order; `eventId` is an identity, not an order.
- **Expect delay from long transactions.** A poller only reads events whose transaction is older than every transaction still open, which is what makes
  "no event is skipped" true. So a long-running transaction anywhere in the database holds delivery back until it ends.

## Ordering

Delivery order is `(transaction_id, position)`: not the order the events were committed, and not their `position` alone. What it guarantees is **causal
order**: if a command read event A before appending event B, every handler sees A before B. The command executor enforces what that needs, a command's append
being the first write of its transaction ([ADR-0033](../adr/0033-delivery-order-is-causal-order.md)); a command run in a transaction that already wrote is refused.

Events that did not read each other have no order you can rely on. Two deposits to the same wallet that ran at the same time can arrive in either order. So:

- **`add` is right in any order** (`balance = balance + amount`).
- **`set` keeps the last one delivered**, which is not necessarily the last one decided, when several commuting events write the same row (the wallet's
  `last_updated_at` can go back a little).
- **A total recorded in a commuting event is a snapshot**: the deposit's `newBalance` is the balance its command saw, possibly stale. Apply the change, not the total
  ([Add a view](../guides/build/add-a-view.md)).

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
