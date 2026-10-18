# @crablet/views

Read models: a **projector** turns events into rows of a table, driven by the poller. Views update asynchronously; this package also knows how far each view has got,
so a read can wait for a write.

## What it gives you

- **`defineView`** (`/ProjectedView`), **`viewTable`** and its column types (`/ViewTable`) - a view declared as what each event does to its tables (`insert`, `update`, `upsert` with `add`/`set`/`max`, `remove`, and `raw` as the escape hatch). What it reads besides its handled event types (`anyOfTags`, ...) is declared with it. It gives the tables it owns and an in-memory run (`applyInMemory`, `/ViewMemory`); **`checkViewTables`** (`/ViewTableCheck`) compares the declared tables with the migrated database ([ADR-0026](../../docs/adr/0026-views-declared-as-operations.md)).
- **`makeViewsProcessor({ views, overrides, config })`**, **`ViewsConfig`** - runs the views; each batch and the view's cursor commit in one transaction. `overrides` sets polling and batch per view, by name. `config` is optional: `ViewsConfig` is a partial of the shared [polling settings](../../docs/reference/configuration.md#polling-settings), and what is left out takes the default.
- **`waitUntilProcessed`** (`/WaitUntilProcessed`) - wait until a view (its `subscription()`) has processed a given write (the marker).
- **`settleViews`** (`/SettleViews`) - the same for every view a read uses, in one call: one statement says where the log ends and where each view is, a marker beyond the end is reported, and only the views still behind go on to wait, with one shared deadline. The outcome names each view that had not caught up. It is what `makeConsistentRead` in [`@crablet/views-http`](../views-http/README.md) waits with.
- **`ViewProgressHub`**, **`ViewProgressFeed`** - view progress announced with one LISTEN per process, fanned out in memory, and the server-sent "ping" feed.
- **`ViewManagementService`** - inspect and control views.

Delivery is at-least-once, but a projector's writes commit in the same transaction as the view's cursor, so a batch handled twice is applied once, **provided the writes go through the `sql` the projector is given** ([ADR-0023](../../docs/adr/0023-view-batch-and-cursor-in-one-transaction.md)). A projector that writes elsewhere must be **idempotent**. A view keeps no bookkeeping of its own for this: the processor guarantees it.

## Internal

`ViewProgress` (the progress channel), `ViewProjector` (`makeTransactionalViewProjector`, the engine under `defineView`) and `ViewSubscription` (a view's selection, as the processor reads it) are plumbing: it is listed under `crablet.internal` in
[`package.json`](./package.json), applications and the documents do not import it, and it can change without notice ([the boundary](../../docs/reference/README.md#public-api-and-plumbing)).

## Depends on

[`@crablet/eventstore`](../eventstore/README.md), [`@crablet/event-poller`](../event-poller/README.md), `@crablet/metrics-otel`.

## Read more

[Tutorial step 4](../../docs/tutorial/04-read-your-own-writes.md), [ADR-0014](../../docs/adr/0014-live-updates-by-ping.md), [ADR-0015](../../docs/adr/0015-read-consistency-by-marker.md),
[ADR-0016](../../docs/adr/0016-one-listen-per-process-for-view-progress.md). The HTTP side is [`@crablet/views-http`](../views-http/README.md).

Unit tests: `bun test packages/views/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/views/test/integration/*.test.ts"`.
