# @crablet/eventstore

The event log on PostgreSQL: **conditional append**, **tag queries**, and the wake-up and leadership primitives the pollers build on. Everything else in the
framework sits on top of this package.

## What it gives you

- **`EventStore`** (`@crablet/eventstore`) - the service: append events with an append condition ("only if nothing matching this query is newer than this position"),
  and read or project the events a query selects. `EventStoreLive` is its layer. An idempotency condition that matches fails with `Duplicate`, which says what it
  matched (the latest event and the requests behind the matches); `findDuplicate` asks the same before appending ([ADR-0034](../../docs/adr/0034-a-repeat-must-be-the-same-request.md)).
  Every stored event has a stable `eventId`, its public identity, not an order ([ADR-0036](../../docs/adr/0036-outbox-delivery-event-id-timeout-and-partial-progress.md)).
- **Building blocks** - `Tag`, `Query`, `AppendEvent`, `AppendCondition`, `LogPosition` and `Marker`, each its own import (`@crablet/eventstore/Query`, ...).
- **`Leader`** - a session-level advisory lock for "one process runs this"; **`SessionClients`** - an optional direct connection for the leader and LISTEN when the application's connection goes through a pooler in transaction mode ([ADR-0024](../../docs/adr/0024-session-connections-for-leader-and-listen.md)).
- **`EventDecoding`** - the typed `EventDecodingError` for a stored event that cannot be read.
- **`Storage`** - `storageReport()` and `monitorStorage()`: the size of the log and its indexes ([ADR-0019](../../docs/adr/0019-storage-visibility-and-the-tag-table.md)).
- **`CommandAuditStore`** - the optional audit of commands.
- **`testing/InMemoryEventStore`** and **`spec/Spec`** - an in-memory store with the same rules as Postgres, and the conformance suite both must pass.

## Internal

`CorrelationContext`, `Listen` (the reconnecting LISTEN), `NotifyPayload` (the wake-up payload) and `ReadSnapshot` (what a read could see: the snapshot
`project` returns as `seen`, which the commands combine and put in `AppendCondition.seen`, so an event the read saw is not a conflict,
[ADR-0048](../../docs/adr/0048-a-conflict-is-what-the-read-did-not-see.md)) are plumbing for the sibling packages. They are listed under `crablet.internal` in
[`package.json`](./package.json), applications and the documents do not import them, and they can change without notice ([the boundary](../../docs/reference/README.md#public-api-and-plumbing)).

## Depends on

`effect`, `@effect/sql-pg`, and `@crablet/metrics-otel` for the metrics. The schema comes from [`@crablet/db-migrations`](../db-migrations/README.md).

## Read more

[DCB guide](../../docs/concepts/dcb-guide.md) (what an append condition is for), [ADR-0003](../../docs/adr/0003-non-commutative-append-concurrency-protection.md),
[ADR-0012](../../docs/adr/0012-transaction-position-cursors.md) (cursors), [ADR-0005](../../docs/adr/0005-listen-notify-implementation.md) and
[ADR-0006](../../docs/adr/0006-leader-election-via-sql-reserve.md). You usually reach this package through [`@crablet/commands`](../commands/README.md) rather than directly.

Unit tests: `bun test packages/eventstore/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/eventstore/test/integration/*.test.ts"`. Diagnostics (storage cost, outside CI): `packages/eventstore/diagnostics/`.
