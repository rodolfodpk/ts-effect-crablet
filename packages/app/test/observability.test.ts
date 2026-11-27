import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Exit, Layer } from "effect";
import { hostname } from "node:os";
import * as Crablet from "../src/index.ts";

const settings = (env: Record<string, string>) =>
  Effect.runPromiseExit(Effect.gen(function* () { return yield* Crablet.observabilityConfig("my-service"); }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))));
const value = async (env: Record<string, string>) => {
  const exit = await settings(env);
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
  return exit.value;
};

describe("Crablet.observability: OTLP from the OTEL_* variables", () => {
  test("unset or empty endpoint: nothing to export; the service is the call's name and the instance the host name", async () => {
    expect(await value({})).toEqual({ endpoint: undefined, serviceName: "my-service", instanceId: hostname() });
    expect((await value({ OTEL_EXPORTER_OTLP_ENDPOINT: "" })).endpoint).toBeUndefined();
  });

  test("the variables win: endpoint, service name, instance id", async () => {
    expect(await value({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_SERVICE_NAME: "wallet", OTEL_SERVICE_INSTANCE_ID: "pod-a" })).toEqual({
      endpoint: "http://collector:4318",
      serviceName: "wallet",
      instanceId: "pod-a"
    });
  });

  test("the resource names the service and its instance, and its product as service.namespace when there is one", () => {
    const s = { endpoint: "http://localhost:4318", serviceName: "wallet-api", instanceId: "pod-a" };
    expect(Crablet.resourceOf(s)).toEqual({ serviceName: "wallet-api", attributes: { "service.instance.id": "pod-a" } });
    expect(Crablet.resourceOf(s, { product: "wallet" })).toEqual({
      serviceName: "wallet-api",
      attributes: { "service.instance.id": "pod-a", "service.namespace": "wallet" }
    });
    expect(Crablet.resourceOf(s, { product: undefined }).attributes).not.toHaveProperty("service.namespace");
  });

  test("without an endpoint the exporter is exactly the empty layer; with one it is not", () => {
    expect(Crablet.otlpLayer({ endpoint: undefined, serviceName: "s", instanceId: "i" })).toBe(Layer.empty);
    expect(Crablet.otlpLayer({ endpoint: "http://localhost:4318", serviceName: "s", instanceId: "i" })).not.toBe(Layer.empty);
  });

  test("the layer builds from an empty configuration (nothing exported) and runs what it is provided to", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.succeed(1).pipe(Effect.provide(Crablet.observability("my-service")), Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))))
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
