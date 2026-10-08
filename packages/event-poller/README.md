# @crablet/event-poller

The generic polling engine behind views, the outbox and automations: it reads new events after a **cursor**, hands them to a handler, and records progress. It is
shared so the three modules get the same guarantees.

## What it gives you

- **`makeEventProcessor`** - one processor per id: backoff, a wake-up on LISTEN/NOTIFY, and **leader-gated** (only the process holding the advisory lock runs it).
- **Guarantees** - no event is skipped (the cursor is a `(transaction_id, position)` pair), **at-least-once** delivery, a fence before the handler and before the cursor moves,
  and a cursor that can only move forward.
- **`EventSelection`**, **`SqlEventFetcher`** - which events a processor wants (types and tags) and the SQL that fetches them.
- **`ProgressTracker`** / **`PostgresProgressTracker`**, **`ProgressCursor`**, **`ProgressPing`** - where a processor has got to.
- **`monitorProcessors`** (`@crablet/event-poller/MonitorProcessors`) - keeps the `crablet.poller.lag_*`, cursor and status gauges current.
- **`ProcessorManagementService`**, **`ProcessorStatus`**, **`ProcessorConfig`** - inspect and control processors (pause, reset, status).

## Depends on

[`@crablet/eventstore`](../eventstore/README.md) (`Leader`, `Listen`), `@crablet/metrics-otel`, `effect`, `@effect/sql-pg`.

## Read more

[Reference: delivery guarantees](../../docs/reference.md#views-the-outbox-and-automations), [ADR-0007](../../docs/adr/0007-event-poller-fiber-model.md),
[ADR-0012](../../docs/adr/0012-transaction-position-cursors.md), [Reliability and scale report](../../docs/plans/reliability-and-scale-diagnostic.md).
You normally use it through [views](../views/README.md), [outbox](../outbox/README.md) or [automations](../automations/README.md).

Unit tests: `bun test packages/event-poller/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/event-poller/test/integration/*.test.ts"`. Diagnostics (outside CI): `packages/event-poller/diagnostics/`.
