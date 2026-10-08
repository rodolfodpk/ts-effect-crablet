# See it on a dashboard

A Grafana dashboard and alert rules for a Crablet application, fed by OpenTelemetry: the poller and its consumers (lag, status, leader), failures, the write side and storage.
You can try it in two minutes with the wallet example, then wire the same three things into your own application.

[← Task guides](README.md)

## Try it

You need Docker and Node. From the repository root:

```bash
docker compose -f ops/compose.yaml up -d
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/wallet-example-app/src/index.ts
node examples/wallet-example-app/scripts/load.ts            # in a second terminal; --rate 250 makes the views fall behind
```

Open <http://localhost:3000> (user `admin`, password `admin`) and choose the **Crablet** dashboard. The compose file starts Postgres and `grafana/otel-lgtm`, one image holding an
OpenTelemetry Collector, Prometheus, Tempo, Loki and Grafana, with the dashboard and the alert rules mounted in. It is for trying things, not a production topology.
`docker compose -f ops/compose.yaml down -v` removes it.

The example sends nothing unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Its first start applies the schema to the empty database; later starts leave it alone.

## What the dashboard shows

| Row | Answers | From |
|---|---|---|
| Is everything healthy? | how many processors are `FAILED`, paused or without a leader; who leads each | `crablet.poller.status`, `crablet.poller.leadership` |
| Are the consumers keeping up? | lag in events and in seconds per processor, throughput, idle polls, backoff | `crablet.poller.lag_*`, `cursor_position` |
| Is it failing? | failures and times of views, automations and the outbox; stored events nobody can read | `crablet.view.*`, `crablet.automation.*`, `crablet.outbox.*`, `crablet.eventstore.decoding_failures` |
| The write side | appends, contention, command and append times, reads that waited for views | `crablet.command.*`, `crablet.eventstore.*`, `crablet.read.consistency.*` |
| Storage | table sizes, rows, bytes per event | `crablet.storage.*` |

Lag is the events a processor **selects** that are waiting after its cursor, and the age of the first of them: it is zero for a consumer of a rare event type that has everything, however far
the end of the log is ([Monitor it](monitor-it.md#are-the-consumers-keeping-up)). The six alert rules (a processor `FAILED`, a processor with no leader, a consumer more than five minutes behind, failing
handlers, stored events that cannot be read, bytes per event) are in `ops/grafana/alerts.yaml`; their thresholds are constants there.

## Put it in your application

Three things, all in the example's entry point.

**1. Export over OTLP**, only when an endpoint is configured. Effect ships the exporter; nothing to install.

<!-- file: examples/wallet-example-app/src/Observability.ts#otlp -->
```ts
export const observabilityLayer = (env: Readonly<Record<string, string | undefined>> = process.env): Layer.Layer<never> => {
  const endpoint = env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (endpoint === undefined || endpoint === "") return Layer.empty;
  return Otlp.layerJson({
    baseUrl: endpoint,
    resource: { serviceName: env["OTEL_SERVICE_NAME"] ?? "wallet-example-app" },
    metricsExportInterval: "5 seconds",
    loggerMergeWithExisting: true
  }).pipe(Layer.provide(FetchHttpClient.layer));
};
```

Provide it next to your application layer: `Effect.provide(Effect.scoped(program), Layer.mergeAll(appLayer, observabilityLayer()))`. Closing the scope flushes what is still buffered.
With it, the metrics, the spans (`crablet.command`, `crablet.eventstore.append`, `crablet.poller.batch`, [Monitor it](monitor-it.md#traces-and-log-context)) and the logs arrive, and a log line carries the trace id of the request that wrote it.

**2. Report the consumers**, in every instance, for as long as the scope lives:

<!-- file: examples/wallet-example-app/src/WalletApp.ts#monitor-processors -->
```ts
export const monitorBackgroundProcessors = (
  processors: BackgroundProcessors,
  instanceId: string = defaultInstanceId()
): Effect.Effect<void, never, SqlClient.SqlClient | Scope.Scope> =>
  Effect.gen(function* () {
    const sources = yield* processorSources(processors);
    yield* Effect.forkScoped(monitorProcessors(sources.map((s) => s.service), { instanceId }));
  });
```

Without it the lag, cursor and status panels stay empty. Every instance reports the same values (so a processor still shows its lag when its leader has died), and the queries take the `max`.

**3. Report storage:** `yield* Effect.forkScoped(monitorStorage({ every: "1 minute" }))` from `@crablet/eventstore/Storage`. Without it the Storage row stays empty.

## Use your own stack

- **Collector and Prometheus:** point `OTEL_EXPORTER_OTLP_ENDPOINT` at your Collector's OTLP/HTTP port (4318). The queries expect the names Prometheus gives the metrics when they arrive by OTLP: a counter keeps its name
  (`crablet_poller_events_fetched`), a gauge gains `_ratio` (`crablet_poller_lag_events_ratio`), a timer becomes `_milliseconds_bucket`, `_count`, `_sum`. A Collector that renames or adds suffixes
  needs the queries changed.
- **Grafana:** import `ops/grafana/crablet-dashboard.json` (Dashboards > New > Import) and choose your Prometheus data source, or mount it and `ops/grafana/provider.yaml` as provisioning. Mount `ops/grafana/alerts.yaml` under
  `provisioning/alerting/`, and change its `datasourceUid` (`prometheus`) to yours. Do not edit the dashboard JSON: it is generated by `scripts/build-dashboard.ts`, and a test fails if the two differ.
- **Another backend** (Datadog, New Relic, Honeycomb): the metrics and spans arrive over OTLP and the metric names are the same, but the dashboard and alerts are PromQL for Grafana; build the panels from the table above.
- **Several instances:** each reports its own `instance_id`. Nothing needs configuring; the dashboard aggregates with `max`.

## Act on a processor

The dashboard only watches. To pause, resume or reset a processor over HTTP, mount the admin API ([`@crablet/processors-http`](../../packages/processors-http/README.md), [ADR-0020](../adr/0020-processors-admin-api.md)); the wallet example does when `WALLET_ADMIN_TOKEN` is set, and it is closed without an authorization you provide. [`examples/processors-admin-ui`](../../examples/processors-admin-ui/README.md) is a generic page for it: a table of the processors with Pause, Resume and Reset.

## When a panel is red

| You see | Do |
|---|---|
| a processor `FAILED` | read its last error (the progress details of its management service, or the logs, filtered by the `processor` attribute), fix the cause, then reset it: [Monitor it](monitor-it.md#inspect-and-control-processors) |
| a processor with no leader | no instance is running it, or a crashed leader's series has not gone stale yet (about five minutes); check the instances and [Run it in production](run-in-production.md) |
| a consumer behind and rising | the processor is slow or stuck: look at its failures and its backoff; the example's defaults (batch 100, one-second polling) fall behind at a few hundred commands a second, which `load.ts --rate 250` shows |
| stored events that cannot be read | an unsafe event change: [Evolving events](../evolving-events.md) |

## What it costs

The sampler runs one small query per processor per interval (15 seconds by default): it counts the processor's pending events up to 100 000 and reads the first one's time. Measured on 2 million events in Postgres 18, that took 0 to 14 ms,
and 97 ms in the worst case (a processor at the start of the log whose selection matches every event, hitting the cap). It reads, never writes.
