# @crablet/event-poller

The generic polling engine behind views, the outbox and automations: it reads new events after a **cursor**, hands them to a handler, and records progress. It is
shared so the three modules get the same guarantees.

## What it gives you

- **`makeEventProcessor`** - one processor per id: backoff, a wake-up on LISTEN/NOTIFY, and **leader-gated** (only the process holding the module's advisory lock runs it; the lock is per module, shared by all the module's processors).
- **Guarantees** - no event is skipped (the cursor is a `(transaction_id, position)` pair), **at-least-once** delivery, a fence before the handler and before the cursor moves,
  and a cursor that can only move forward. With `atomically` (views use it) the handler's writes and the cursor commit in one transaction, and a batch whose cursor move matches no row (another processor took it first) is rolled back, so it is applied once ([ADR-0023](../../docs/adr/0023-view-batch-and-cursor-in-one-transaction.md)).
- **`EventSelection`**, **`ProgressCursor`**, **`ProcessorRuntimeOverrides`** - which events a processor wants (types and tags), where it has got to, and what a single processor can override of its polling.
- **`monitorProcessors`** (`@crablet/event-poller/MonitorProcessors`) - keeps the `crablet.poller.lag_*`, cursor and status gauges current.
- **`ProcessorManagementService`**, **`ProcessorStatus`** - inspect and control processors (pause, reset, status).
- **`ProcessorConfig`** - `PollingConfig` and `defaultPollingConfig`, the one list of polling settings and their defaults ([ADR-0030](../../docs/adr/0030-one-polling-config.md)).

## Internal

The fetcher, handler and progress-tracker interfaces and their Postgres versions (`EventFetcher`, `EventHandler`, `SqlEventFetcher`, `ProgressTracker`, `PostgresProgressTracker`),
`ProgressPing` and `BackoffState` are the engine's own parts, built on by the views, automations and outbox modules. This package is not a way to write your own processor: they are
listed under `crablet.internal` in [`package.json`](./package.json), applications and the documents do not import them, and they can change without notice
([the boundary](../../docs/reference/README.md#public-api-and-plumbing)).

## Depends on

[`@crablet/eventstore`](../eventstore/README.md) (`Leader`, `Listen`), `@crablet/metrics-otel`, `effect`, `@effect/sql-pg`.

## Read more

[Delivery guarantees](../../docs/concepts/views-and-delivery.md), [ADR-0007](../../docs/adr/0007-event-poller-fiber-model.md),
[ADR-0012](../../docs/adr/0012-transaction-position-cursors.md), [Reliability and scale report](../../docs/history/plans/reliability-and-scale-diagnostic.md).
You normally use it through [views](../views/README.md), [outbox](../outbox/README.md) or [automations](../automations/README.md).

Unit tests: `bun test packages/event-poller/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/event-poller/test/integration/*.test.ts"`. Diagnostics (outside CI): `packages/event-poller/diagnostics/`.
