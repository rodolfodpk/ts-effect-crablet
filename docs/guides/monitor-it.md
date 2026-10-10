# Monitor it

What to watch, and how. The framework records its measurements as Effect `Metric`s ([`@crablet/metrics-otel`](../../packages/metrics-otel/README.md)); **this repository does not
ship an exporter**, so wire Effect's OpenTelemetry (or another) metrics exporter in your application. Nothing below needs one except the gauges.

[← Task guides](README.md) · A ready-made Grafana dashboard for all of this: [See it on a dashboard](dashboard.md)

## Storage: how big, and what an event costs

A one-off report, read from the catalog without scanning a table:

<!-- file: examples/wallet-example-app/scripts/report-storage.ts#report -->
```ts
const report = await Effect.runPromise(Effect.provide(storageReport({ exact: process.argv.includes("--exact") }), layer) as Effect.Effect<StorageReport, never, never>);
console.log(formatStorageReport(report));
```

Run the script as `node examples/wallet-example-app/scripts/report-storage.ts` (add `--exact` to count the events table). In a running application, keep the gauges
current instead: `Effect.forkDetach(monitorStorage({ every: "5 minutes" }))` from `@crablet/eventstore/Storage`. Nothing deletes events and retention is not decided
([ADR-0019](../adr/0019-storage-visibility-and-the-tag-table.md)), so watch `crablet.storage.bytes_per_event` and `crablet.storage.table_bytes` and plan ahead.

## Are the consumers keeping up?

The processing loop cannot report this for a processor that has no leader, so a sampler does, in every instance:
`Effect.forkDetach(monitorProcessors([viewManagement, automationManagement, outboxManagement], { every: "15 seconds" }))` from `@crablet/event-poller/MonitorProcessors`, with the
management services of the modules the process runs. It reads each processor's status and cursor and counts what is waiting for it, **against that processor's own selection**.
(The distance from the end of the whole log is not the number to watch: a cursor only ever lands on an event the processor selected, so a consumer of a rare event type is far
from the head of the log when it has everything.) It never writes, and a failed read is logged and tried again.

| Gauge (tags `processor`, `instance_id`) | Meaning |
|---|---|
| `crablet.poller.lag_events` | events the processor selects that are committed and after its cursor, counted up to 100 000 |
| `crablet.poller.lag_seconds` | age, by the events' own `occurred_at`, of the first of them; 0 when caught up |
| `crablet.poller.cursor_position` | the cursor's position |
| `crablet.poller.status` (also tagged `status`) | 1 for the processor's current `ACTIVE`, `PAUSED` or `FAILED`, 0 for the other two |

Every instance reports the same values, so aggregate with `max`, never `sum`. The processor id of a view is its name; of an outbox publisher, the JSON pair `["topic","publisher"]`.

## What to watch

Suggestions, by what each metric tells you:

| Metric | What it tells you |
|---|---|
| `crablet.poller.leadership` | 1 when this instance acquires a **module**'s leader lock (views, automations or outbox: leadership is per module), 0 when it loses it; tagged `lock_key` and `instance_id`. A crashed leader never reports 0: its series stays at 1 but stops being re-sent, so look for a recent sample. No fresh sample at 1 for a lock means nothing is processing that module |
| `crablet.view.project.failures`, `crablet.automation.decide.failures`, `crablet.outbox.publish.failures` | a handler is failing; the error is recorded against the processor |
| `crablet.eventstore.decoding_failures` | a stored event the current definitions cannot read (an unsafe event change) |
| `crablet.command.conflict_retries`, `crablet.eventstore.concurrency_violations` | contention: commands whose boundaries overlap |
| `crablet.period.clock_behind` | a command found a period open that is later than its clock says (a model with a period never turns one back): a few is a pod a little behind, a steady rate is clocks that disagree ([ADR-0025](../adr/0025-the-framework-turns-the-period.md)) |
| `crablet.eventstore.wakeups_recorded`, `_sent`, `_saved` | the wake-up notifications ([ADR-0021](../adr/0021-wakeups-after-commit-and-coalesced.md)): recorded per committed transaction, sent to Postgres, and saved by merging them. `sent` should stay near 1 / window per process |
| `crablet.read.consistency.wait.duration` | how long a read's first look and wait take (it dropped when the first look became one statement, [ADR-0015](../adr/0015-read-consistency-by-marker.md)) |
| `crablet.poller.backoff_active` | a processor has backed off after errors or empty polls |
| `crablet.poller.lag_events`, `crablet.poller.lag_seconds` | a consumer is behind (see above); `lag_seconds` rising while the processor is `ACTIVE` means it is stuck or slow |
| `crablet.poller.status` | a processor is `FAILED` (too many errors) or `PAUSED` |
| `crablet.storage.*` | the size of the log and of each library table, and bytes per event |

**With more than one instance, each must export with its own identity** (`service.instance.id`; the wallet uses `OTEL_SERVICE_INSTANCE_ID`, by default the host name, which is the pod name on Kubernetes). Without it two instances write the same series, Prometheus sees a counter that keeps
dropping and adds the whole value at each drop: on the kind lab, `rate()` came out 20 to 30 times too high ([the lab](../plans/kind-lab.md)).

## Traces and log context

The framework opens spans and annotates its logs, so a tracer and a log sink you wire in can answer "where did this command spend its time". As with metrics, **no exporter is shipped**: provide
Effect's tracer for your backend (for example OpenTelemetry) and the spans appear.

| Span | Opened by | Attributes |
|---|---|---|
| `crablet.command` | each command execution, retries included | `crablet.command.name`, `crablet.command.max_retries` |
| `crablet.eventstore.project` | reading a boundary | `crablet.project.query_items` |
| `crablet.eventstore.append` | the conditional append | `crablet.append.events`, `crablet.append.event_types` |
| `crablet.poller.batch` | a poll that found events: handling the batch and moving the cursor | `crablet.processor`, `crablet.batch.events` |

The read and the append are inside the command's span, so a slow command shows which of the two it waited for. An idle poll opens no span (it would be one a second per processor). Logs written
by a processor's loop carry `processor` and `instance`, and logs written while a command runs carry `command`, so a log line can be tied to the processor or command that wrote it.

## Inspect and control processors

Each module has a management service (`ViewManagementService`, `AutomationManagementService`, `OutboxManagementService`) on top of the poller's
`ProcessorManagementService`. For a view, its progress details give the status, the instance holding it, the last position, the error count and the last error; the
poller service can pause, resume and reset a processor. They are plain Effect services. To reach them over HTTP, mount [`@crablet/processors-http`](../../packages/processors-http/README.md): a list with status, failures, cursor and
backlog, and pause, resume and reset, behind an authorization you provide ([ADR-0020](../adr/0020-processors-admin-api.md)). Reset clears the error count and restarts the processor; it does not move its cursor.

Delivery guarantees to keep in mind while reading these numbers: [reference](../reference.md#views-the-outbox-and-automations).
