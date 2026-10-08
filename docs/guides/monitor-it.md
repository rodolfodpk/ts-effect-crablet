# Monitor it

What to watch, and how. The framework records its measurements as Effect `Metric`s ([`@crablet/metrics-otel`](../../packages/metrics-otel/README.md)); **this repository does not
ship an exporter**, so wire Effect's OpenTelemetry (or another) metrics exporter in your application. Nothing below needs one except the gauges.

[← Task guides](README.md)

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

## What to watch

Suggestions, by what each metric tells you:

| Metric | What it tells you |
|---|---|
| `crablet.poller.leadership` | 1 when this instance acquires leadership of a processor, 0 when it loses it (tagged by processor and instance); no instance at 1 means nothing is processing |
| `crablet.view.project.failures`, `crablet.automation.decide.failures`, `crablet.outbox.publish.failures` | a handler is failing; the error is recorded against the processor |
| `crablet.eventstore.decoding_failures` | a stored event the current definitions cannot read (an unsafe event change) |
| `crablet.command.conflict_retries`, `crablet.eventstore.concurrency_violations` | contention: commands whose boundaries overlap |
| `crablet.read.consistency.wait.duration` | how long reads wait for views to catch up |
| `crablet.poller.backoff_active` | a processor has backed off after errors or empty polls |
| `crablet.storage.*` | the size of the log and of each library table, and bytes per event |

## Inspect and control processors

Each module has a management service (`ViewManagementService`, `AutomationManagementService`, `OutboxManagementService`) on top of the poller's
`ProcessorManagementService`. For a view, its progress details give the status, the instance holding it, the last position, the error count and the last error; the
poller service can pause, resume and reset a processor. They are plain Effect services you can put behind your own admin endpoint; the repository's apps do not
expose one.

Delivery guarantees to keep in mind while reading these numbers: [reference](../reference.md#views-the-outbox-and-automations).
