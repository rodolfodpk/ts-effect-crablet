# Views

*Reference · developers writing read models · [Add a view](../guides/build/add-a-view.md) · look up*

What `defineView` and `viewTable` accept. The guarantees a view gets are in [views and delivery](../concepts/views-and-delivery.md); the decision is
[ADR-0026](../adr/0026-views-declared-as-operations.md).

## `defineView`

From `@crablet/views/ProjectedView`. `defineView(name, { tables }).on(Event, (data, ctx) => operations)`: each handler is pure and returns operations as
data. The declaration gives the projector, the subscription (the event types handled), the tables the view owns, and an in-memory run (`applyInMemory`).

| Operation | What it does |
|---|---|
| `insert(row, { onConflict })` | Insert a row. `onConflict: "ignore"` keeps the existing row; `"replace"` overwrites it. |
| `update(key, { add, set, max })` | Change an existing row. No row, no change. |
| `upsert(key, { add, set, max })` | Change a row, creating it from the column defaults plus the amounts if it is missing. |
| `remove(key)` | Delete a row. |
| `raw(sql => effect)` | The escape hatch: any SQL, on the `sql` the projector is given, so it still commits with the cursor. |

| Change | Meaning |
|---|---|
| `add` | Add an amount to a numeric column (`balance + amount`). Apply the change, not a total. |
| `set` | Set a column to a value. |
| `max` | Keep the larger of the stored and the new value. |

A column is changed one way in one operation.

## `viewTable`

From `@crablet/views/ViewTable`. Declares a table's columns and key, as the migration made it. The migration stays the truth: `checkViewTables`
(`@crablet/views/ViewTableCheck`) compares the declaration with the migrated database and reports mismatches; it never generates DDL.

| Column type | Postgres |
|---|---|
| `text()` | `text` |
| `integer()` | `integer` |
| `decimal()` | `numeric` |
| `bigint()` | `bigint` |
| `timestamptz()` | `timestamptz` |

Each column can add `.nullable()` and `.default(value)`.

## Processor settings

A view, an automation and an outbox topic each run as a processor with these settings (`ProcessorConfig`, `@crablet/event-poller`).

| Setting | Default | What it does |
|---|---|---|
| `pollingIntervalMs` | required | How often the processor polls when nothing wakes it. |
| `batchSize` | required | The most events handled in one batch (one transaction for a view). |
| `backoffEnabled`, `backoffThreshold`, `backoffMultiplier`, `backoffMaxSeconds` | required | After `backoffThreshold` empty polls or errors, the interval grows by `backoffMultiplier` up to `backoffMaxSeconds`. A wake-up ends the wait. |
| `maxErrors` | `10` | Errors in a row before the processor is marked `FAILED` and stops. |
| `leaderElectionRetryIntervalMs` | `5000` | How often a follower tries to take the module's lock. Bounds the takeover after a crash. |

## Reads over views

A read endpoint wrapped with `makeConsistentRead` (`@crablet/views-http`) declares the views it reads and a read-consistency policy; the options are
in [HTTP](./http.md#read-consistency).
