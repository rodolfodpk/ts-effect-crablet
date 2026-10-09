import { describe, expect, test } from "bun:test";
import { Layer } from "effect";
import { observabilityLayer } from "../src/Observability.ts";

describe("observabilityLayer", () => {
  test("without an endpoint it is exactly the empty layer, so the example needs nothing but a database", () => {
    expect(observabilityLayer({})).toBe(Layer.empty);
    expect(observabilityLayer({ OTEL_EXPORTER_OTLP_ENDPOINT: "" })).toBe(Layer.empty);
  });
  test("with an endpoint it builds a layer, with or without an explicit instance id", () => {
    expect(observabilityLayer({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" })).not.toBe(Layer.empty);
    expect(observabilityLayer({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318", OTEL_SERVICE_INSTANCE_ID: "pod-a" })).not.toBe(Layer.empty);
  });
});
