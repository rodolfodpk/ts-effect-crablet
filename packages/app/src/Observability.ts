// Exporting a process's metrics, spans and logs over OTLP, from the standard OpenTelemetry variables (not under the product's prefix: collectors and
// platforms set these names). Off when OTEL_EXPORTER_OTLP_ENDPOINT is unset or empty, so running an application needs nothing but a database.
//
// Every instance names ITSELF (`service.instance.id`): OTEL_SERVICE_INSTANCE_ID, by default the host name, which is the pod name on Kubernetes. Without
// it two instances export the same series, a counter seems to reset at every export and `rate()` adds the whole value each time: measured on the
// wallet's kind lab, 20 to 30 times the real rate. So there is no way to leave it out.
import { hostname } from "node:os";
import { Config, type Duration, Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import { Otlp } from "effect/observability";

export interface ObservabilitySettings {
  // The collector (for example http://localhost:4318), or undefined: nothing is exported.
  readonly endpoint: string | undefined;
  readonly serviceName: string;
  readonly instanceId: string;
}

export interface ObservabilityOptions {
  // How often the metrics are exported (default 5 seconds).
  readonly metricsExportInterval?: Duration.Input | undefined;
}

// OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME (default: the name the call gives) and OTEL_SERVICE_INSTANCE_ID (default: the host name).
export const observabilityConfig = (serviceName: string): Config.Config<ObservabilitySettings> =>
  Config.all({
    endpoint: Config.String("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(Config.option, Config.map((o) => Option.getOrUndefined(Option.filter(o, (s) => s !== "")))),
    serviceName: Config.String("OTEL_SERVICE_NAME").pipe(Config.withDefault(serviceName)),
    instanceId: Config.String("OTEL_SERVICE_INSTANCE_ID").pipe(Config.withDefault(hostname()))
  });

// The exporter for those settings: exactly `Layer.empty` without an endpoint. Logs still go to the console as well (`loggerMergeWithExisting`);
// closing the scope the layer is built in flushes what is still buffered.
export const otlpLayer = (settings: ObservabilitySettings, options: ObservabilityOptions = {}): Layer.Layer<never> =>
  settings.endpoint === undefined
    ? Layer.empty
    : Otlp.layerJson({
        baseUrl: settings.endpoint,
        resource: { serviceName: settings.serviceName, attributes: { "service.instance.id": settings.instanceId } },
        metricsExportInterval: options.metricsExportInterval ?? "5 seconds",
        loggerMergeWithExisting: true
      }).pipe(Layer.provide(FetchHttpClient.layer));

// #region observability
// `Crablet.observability("wallet-example-app")`: the settings read from the configuration, then the exporter. A bad value fails the layer with a
// `ConfigError` naming the variable. Provide it next to the application layer, once, at the top.
export const observability = (serviceName: string, options: ObservabilityOptions = {}): Layer.Layer<never, Config.ConfigError> =>
  Layer.unwrap(Effect.map(Effect.gen(function* () { return yield* observabilityConfig(serviceName); }), (settings) => otlpLayer(settings, options)));
// #endregion observability
