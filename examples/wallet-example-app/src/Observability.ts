import { Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Otlp } from "effect/observability";

// Exports the application's metrics, spans and logs over OTLP, to the collector at OTEL_EXPORTER_OTLP_ENDPOINT (for example http://localhost:4318). Off when the variable
// is not set, so running the example needs nothing but a database. OTEL_SERVICE_NAME names the service (default "wallet-example-app").
// Logs still go to the console as well (`loggerMergeWithExisting`). Closing the scope the layer is built in flushes what is still buffered.
// #region otlp
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
// #endregion otlp
