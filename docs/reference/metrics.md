# Metrics and spans

*Reference · operators · [Monitor it](../guides/operate/monitor-it.md) · look up*

Every metric and span the packages record, from `@crablet/metrics-otel` and the packages' own sources. They are Effect metrics; the repository ships no
exporter, so wire one in your application ([See it on a dashboard](../guides/operate/dashboard.md) uses OpenTelemetry). Which ones to alert on is in
[Monitor it](../guides/operate/monitor-it.md#what-to-watch).

What a series came from is in the export's resource, not on each series: `service.name` (the deployment), `service.instance.id` (the instance) and
`service.namespace` (the product), set by `Crablet.observability(serviceName, { product })`.

## Commands

| Metric | What it counts or measures |
|---|---|
| `crablet.command.executions`, `crablet.command.execution.duration` | one per execution, after its retries, by `command_type`, `outcome` (`created`, `idempotent`, `rejected`, `mismatch`, `conflict`, `error`) and, for `rejected` and `error`, `error` (the declared error's tag, or the framework's: `SqlError`, `AppendTooLarge`, `EventDecodingError`, `defect`, `interrupted`): what the caller got, and how long it waited ([ADR-0056](../adr/0056-a-command-reports-its-outcome.md)). Alert on `outcome="error"`: `rejected` is a business answer |
| `crablet.command.handle.successes`, `.failures`, `.duration` | each **attempt** (one transaction): succeeded, failed (a retried `Conflict` and a domain error included), and how long it took. How hard the store works, not what callers got |
| `crablet.command.conflict_retries` | commands re-run after a `Conflict`: contention between overlapping boundaries |
| `crablet.command.idempotent_duplicates` | repeats answered as "already done" |
| `crablet.command.idempotency_mismatches` | request ids reused by a different request, refused with 422 (ADR-0034): a client bug, or an `idempotentBy` that is too broad |
| `crablet.period.clock_behind` | a command found a period open that is later than its clock says ([ADR-0025](../adr/0025-the-framework-turns-the-period.md)) |

An input that does not decode (`InvalidInput`, from `run`) is not an execution: nothing ran, so it has no outcome; over HTTP it is a 400 in the request metric below.

## HTTP

| Metric | What it measures |
|---|---|
| `http.server.request.duration` | every request on the router `serveApi` is served on (the commands, the reads, the live feed, and any other route on it), in seconds, by `http.request.method`, `http.route` (the template, `/api/wallets/:walletId`; absent when no route matched) and `http.response.status_code` ([ADR-0056](../adr/0056-a-command-reports-its-outcome.md)) |

It is OpenTelemetry's semantic-convention name, not a `crablet.` one: the HTTP layer is Effect's and the convention's, and backends chart it as it is.
Its unit is set by the `unit: "seconds"` attribute, which Effect's OTLP exporter reads, so Prometheus names it `http_server_request_duration_seconds_*`
(derived from the exporter's code, not measured against a backend like the `crablet.` names). A process that serves only health routes, without
`serveApi`, records none.

## Event store

| Metric | What it counts or measures |
|---|---|
| `crablet.eventstore.append.successes`, `.failures`, `.duration` | appends, failed appends, and how long each took |
| `crablet.eventstore.events_appended`, `crablet.eventstore.event_type_appended` | events appended, in total and by type |
| `crablet.eventstore.concurrency_violations` | appends refused because the boundary changed |
| `crablet.eventstore.decoding_failures` | stored events the current definitions cannot read: an unsafe event change |
| `crablet.eventstore.wakeups_recorded`, `_sent`, `_saved` | wake-up notifications recorded per committed transaction, sent to Postgres, and saved by merging ([ADR-0021](../adr/0021-wakeups-after-commit-and-coalesced.md)) |
| `crablet.storage.table_bytes`, `crablet.storage.table_rows`, `crablet.storage.bytes_per_event` | the size of the log and of each library table, and bytes per event ([ADR-0019](../adr/0019-storage-visibility-and-the-tag-table.md)) |

## Processors (views, automations, outbox, deadlines)

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
| `crablet.deadlines.fired` | deadlines fired, tagged `outcome`: `appended` (the command appended), `noop` (it had nothing to do), `failed` (it failed with something other than a domain error, timed out, or could not be run) |

The lag, cursor and status gauges are kept current by `Crablet.processors` and `Crablet.processorsFor` (`@crablet/app`), for the modules a process runs. For the deadlines processor the
lag gauges count something else: the deadlines that are due and not fired, read from `crablet_deadlines`, and how late the oldest is. The storage gauges are kept current by
`monitorStorage()` (`@crablet/eventstore/Storage`).

## Reads

| Metric | What it counts or measures |
|---|---|
| `crablet.read.consistency.reads` | reads made through `makeConsistentRead` |
| `crablet.read.consistency.wait.duration` | how long a read's first look and wait took |

## Spans

| Span | Covers | Attributes |
|---|---|---|
| `crablet.command` | one command execution, retries included; **ok** when its outcome is an answer (`created`, `idempotent`, `rejected`, `mismatch`), failed for `conflict` and `error` | `crablet.command.name`, `crablet.command.max_retries`, `crablet.command.outcome`, `crablet.command.attempts`, and when they apply `crablet.command.error`, `crablet.command.error_kind`, `crablet.correlation_id` |
| `crablet.eventstore.project` | reading a boundary | `crablet.project.query_items` |
| `crablet.eventstore.append` | the conditional append | `crablet.append.events`, `crablet.append.event_types` |
| `crablet.poller.batch` | a poll that found events: handling the batch and moving the cursor | `crablet.processor`, `crablet.batch.events` |

The request's own span comes from Effect's server (`HttpMiddleware.tracer`): `http.request.method`, the URL, `http.response.status_code` and, under an
exporting tracer, `http.route`. A command run by `serveApi` runs in the request's fiber, so `crablet.command` is its child: one trace from the request to the append.

A metric that is renamed or removed breaks `scripts/dashboard.test.ts` until the dashboard and the alerts follow (see `CONTRIBUTING.md`).
