# Metrics and spans

*Reference · operators · [Monitor it](../guides/operate/monitor-it.md) · look up*

Every metric and span the packages record, from `@crablet/metrics-otel` and the packages' own sources. They are Effect metrics; the repository ships no
exporter, so wire one in your application ([See it on a dashboard](../guides/operate/dashboard.md) uses OpenTelemetry). Which ones to alert on is in
[Monitor it](../guides/operate/monitor-it.md#what-to-watch).

## Commands

| Metric | What it counts or measures |
|---|---|
| `crablet.command.handle.successes`, `.failures`, `.duration` | commands handled, failed, and how long each took |
| `crablet.command.conflict_retries` | commands re-run after a `Conflict`: contention between overlapping boundaries |
| `crablet.command.idempotent_duplicates` | repeats answered as "already done" |
| `crablet.period.clock_behind` | a command found a period open that is later than its clock says ([ADR-0025](../adr/0025-the-framework-turns-the-period.md)) |

## Event store

| Metric | What it counts or measures |
|---|---|
| `crablet.eventstore.append.successes`, `.failures`, `.duration` | appends, failed appends, and how long each took |
| `crablet.eventstore.events_appended`, `crablet.eventstore.event_type_appended` | events appended, in total and by type |
| `crablet.eventstore.concurrency_violations` | appends refused because the boundary changed |
| `crablet.eventstore.decoding_failures` | stored events the current definitions cannot read: an unsafe event change |
| `crablet.eventstore.wakeups_recorded`, `_sent`, `_saved` | wake-up notifications recorded per committed transaction, sent to Postgres, and saved by merging ([ADR-0021](../adr/0021-wakeups-after-commit-and-coalesced.md)) |
| `crablet.storage.table_bytes`, `crablet.storage.table_rows`, `crablet.storage.bytes_per_event` | the size of the log and of each library table, and bytes per event ([ADR-0019](../adr/0019-storage-visibility-and-the-tag-table.md)) |

## Pollers (views, automations, outbox)

| Metric | What it counts or measures |
|---|---|
| `crablet.poller.leadership` | 1 when this instance takes a module's lock, 0 when it loses it; tagged `lock_key` and `instance_id`. A crashed leader never reports 0, so look for a recent sample. |
| `crablet.poller.status` | 1 for the processor's current status (`ACTIVE`, `PAUSED`, `FAILED`), 0 for the others |
| `crablet.poller.lag_events` | events the processor selects that are committed and after its cursor, counted up to 100,000 |
| `crablet.poller.lag_seconds` | the age of the first of them; 0 when caught up |
| `crablet.poller.cursor_position` | the cursor's position |
| `crablet.poller.events_fetched`, `crablet.poller.processing_cycles`, `crablet.poller.empty_polls` | events read, polls made, and polls that found nothing |
| `crablet.poller.backoff_active`, `crablet.poller.backoff_empty_poll_count` | a processor has backed off, and the empty polls that led to it |
| `crablet.view.events_projected`, `crablet.view.project.successes`, `.failures`, `.duration` | a view's projector |
| `crablet.automation.events_processed`, `crablet.automation.decide.successes`, `.failures`, `.duration` | an automation |
| `crablet.outbox.events_published`, `crablet.outbox.publish.successes`, `.failures`, `.duration` | an outbox publisher |

The lag, cursor and status gauges are kept current by `monitorProcessors()` (`@crablet/event-poller/MonitorProcessors`); the storage gauges by
`monitorStorage()` (`@crablet/eventstore/Storage`).

## Reads

| Metric | What it counts or measures |
|---|---|
| `crablet.read.consistency.reads` | reads made through `makeConsistentRead` |
| `crablet.read.consistency.wait.duration` | how long a read's first look and wait took |

## Spans

| Span | Covers | Attributes |
|---|---|---|
| `crablet.command` | one command execution, retries included | `crablet.command.name`, `crablet.command.max_retries` |
| `crablet.eventstore.project` | reading a boundary | `crablet.project.query_items` |
| `crablet.eventstore.append` | the conditional append | `crablet.append.events`, `crablet.append.event_types` |
| `crablet.poller.batch` | a poll that found events: handling the batch and moving the cursor | `crablet.processor`, `crablet.batch.events` |

A metric that is renamed or removed breaks `scripts/dashboard.test.ts` until the dashboard and the alerts follow (see `CONTRIBUTING.md`).
