# @crablet/metrics-otel

The metric names and instruments for the whole framework, defined with Effect's `Metric`, so you export them with whatever OpenTelemetry exporter your application
configures. Every metric is named `crablet.<area>.<what>`.

## What it gives you

One module per area, each its own import (`@crablet/metrics-otel/PollerMetrics`, ...): **EventStoreMetrics**, **CommandMetrics**, **PollerMetrics**, **LeaderMetrics**,
**ViewMetrics**, **OutboxMetrics**, **AutomationMetrics**, **ReadConsistencyMetrics** and **StorageMetrics** (the `crablet.storage.*` gauges that `monitorStorage` keeps current).

The other packages record into these; you do not call them yourself, you only wire an exporter.

## Depends on

`effect` only.

## Read more

[Reference: operating it](../../docs/reference.md#operating-it), [ADR-0019](../../docs/adr/0019-storage-visibility-and-the-tag-table.md).

Unit tests: `bun test packages/metrics-otel/test/*.test.ts`.
