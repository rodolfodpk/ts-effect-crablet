import { Metric } from "effect";

// The served API's requests (ADR-0056), recorded by `serveApi` (@crablet/commands-http): OpenTelemetry's semantic-convention name, unit and
// buckets, not a `crablet.` name, because the HTTP layer is Effect's and the convention's, and backends chart it as it is. By
// ("http.request.method", GET), ("http.route", the router's template, /api/wallets/:walletId; absent when no route matched) and
// ("http.response.status_code", 200). The `unit` attribute is how Effect's OTLP exporter sets the unit: seconds, so Prometheus names it
// http_server_request_duration_seconds_*.
export const requestDuration = Metric.histogram("http.server.request.duration", {
  boundaries: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10],
  attributes: { unit: "seconds" }
});
