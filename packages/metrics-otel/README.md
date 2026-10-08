# @crablet/metrics-otel

The metric names and instruments for the whole framework, defined with Effect's `Metric`, so you export them with whatever OpenTelemetry exporter your application
configures. Every metric is named `crablet.<area>.<what>`.

## What it gives you

One module per area, each its own import (`@crablet/metrics-otel/PollerMetrics`, ...): **EventStoreMetrics**, **CommandMetrics**, **PollerMetrics**, **LeaderMetrics**,
**ViewMetrics**, **OutboxMetrics**, **AutomationMetrics**, **ReadConsistencyMetrics** and **StorageMetrics** (the `crablet.storage.*` gauges that `monitorStorage` keeps current).

The other packages record into these; you do not call them yourself, you only wire an exporter. Two are not recorded by the processing loop: `monitorStorage` keeps the `crablet.storage.*` gauges current, and
`monitorProcessors` (`@crablet/event-poller/MonitorProcessors`) keeps `crablet.poller.lag_events`, `lag_seconds`, `cursor_position` and `status`, so a processor with no leader still reports.

## Names at the backend

Exported over OTLP to Prometheus, a counter keeps its name (`crablet_poller_events_fetched`), a gauge gains `_ratio` (`crablet_poller_lag_events_ratio`), and a timer becomes `<name>_milliseconds_bucket`, `_count` and `_sum`
(measured against the `grafana/otel-lgtm` image; another Collector may differ). [`ops/grafana`](../../ops/grafana/README.md) has a dashboard and alert rules over these names, and a test keeps them in step with this package:
adding a metric means giving it a panel or saying why not ([CONTRIBUTING](../../CONTRIBUTING.md)).

## Depends on

`effect` only.

## Read more

[Reference: operating it](../../docs/reference.md#operating-it), [ADR-0019](../../docs/adr/0019-storage-visibility-and-the-tag-table.md).

Unit tests: `bun test packages/metrics-otel/test/*.test.ts`.
