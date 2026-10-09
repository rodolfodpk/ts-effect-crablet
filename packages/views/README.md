# @crablet/views

Read models: a **projector** turns events into rows of a table, driven by the poller. Views update asynchronously; this package also knows how far each view has got,
so a read can wait for a write.

## What it gives you

- **`ViewProjector`** and **`makeTransactionalViewProjector`** (`/ViewProjector`) - a projector is `handle(events)` for a batch; the transactional one runs the whole batch in one transaction (a failure rolls back the batch) and passes each event's correlation and causation ids on.
- **`makeViewsProcessor`**, **`ViewsConfig`**, **`ViewSubscription`** - register the projectors and run them.
- **`waitUntilProcessed`** (`/WaitUntilProcessed`) - wait until a view has processed a given write (the marker).
- **`ViewProgress`**, **`ViewProgressHub`**, **`ViewProgressFeed`** - view progress announced with one LISTEN per process, fanned out in memory, and the server-sent "ping" feed.
- **`ViewManagementService`** - inspect and control views.

Delivery is at-least-once, but a projector's writes commit in the same transaction as the view's cursor, so a batch handled twice is applied once, **provided the writes go through the `sql` the projector is given** ([ADR-0023](../../docs/adr/0023-view-batch-and-cursor-in-one-transaction.md)). A projector that writes elsewhere must be **idempotent**; the wallet's statement projector is the worked example.

## Depends on

[`@crablet/eventstore`](../eventstore/README.md), [`@crablet/event-poller`](../event-poller/README.md), `@crablet/metrics-otel`.

## Read more

[Tutorial step 4](../../docs/tutorial/04-read-your-own-writes.md), [ADR-0014](../../docs/adr/0014-live-updates-by-ping.md), [ADR-0015](../../docs/adr/0015-read-consistency-by-marker.md),
[ADR-0016](../../docs/adr/0016-one-listen-per-process-for-view-progress.md). The HTTP side is [`@crablet/views-http`](../views-http/README.md).

Unit tests: `bun test packages/views/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/views/test/integration/*.test.ts"`.
