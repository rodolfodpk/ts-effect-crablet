# Grafana: dashboard and alerts for Crablet

- **`crablet-dashboard.json`** - the dashboard: *Is everything healthy?*, *Are the consumers keeping up?*, *Is it failing?*, *The write side*, *Storage*. **Generated** by
  [`scripts/build-dashboard.ts`](../../scripts/build-dashboard.ts): change the generator and run `bun run dashboard:build`, never the JSON.
- **`alerts.yaml`** - six alert rules in Grafana's file provisioning format. Thresholds are defaults; edit them in the file.

Both query Prometheus with the names the metrics get when they arrive by OTLP (a counter keeps its name, a gauge gains `_ratio`, a timer becomes
`<name>_milliseconds_bucket`, `_count`, `_sum`), and both are checked against [`@crablet/metrics-otel`](../../packages/metrics-otel/README.md) by
[`scripts/dashboard.test.ts`](../../scripts/dashboard.test.ts): a renamed metric, a hand-edited dashboard, or a metric with neither a panel nor a stated reason fails the test.

## Use it

- **Import:** Grafana > Dashboards > New > Import > upload the JSON, and pick your Prometheus data source in the `Data source` variable.
- **Provision:** mount the JSON into a dashboard provider folder and `alerts.yaml` into `provisioning/alerting/`. Both were loaded this way by the `grafana/otel-lgtm` image;
  the alert rules use the data source uid `prometheus` (that image's), so change `datasourceUid` for another Grafana.
- **Another backend** (Datadog, New Relic, Honeycomb): the metrics and spans arrive over OTLP, but the queries are PromQL; swap them.

The consumer gauges (`crablet.poller.lag_*`, `cursor_position`, `status`) exist only if the application runs
[`monitorProcessors`](../../docs/guides/monitor-it.md#are-the-consumers-keeping-up). Every instance reports the same values, so the queries take the `max`.
