import { describe, expect, test } from "bun:test";
import { processorConfigOf } from "../src/ProcessorConfig.ts";
import { resolveOverride } from "../src/ProcessorRuntimeOverrides.ts";

describe("processorConfigOf", () => {
  test("supplies Java defaults for maxErrors/leaderElectionRetryIntervalMs when omitted", () => {
    const config = processorConfigOf("view-a", {
      pollingIntervalMs: 1000,
      batchSize: 100,
      backoffEnabled: true,
      backoffThreshold: 3,
      backoffMultiplier: 2,
      backoffMaxSeconds: 120,
      enabled: true
    });
    expect(config.maxErrors).toBe(10);
    expect(config.leaderElectionRetryIntervalMs).toBe(30_000);
    expect(config.processorId).toBe("view-a");
  });

  test("allows overriding the defaulted fields", () => {
    const config = processorConfigOf("view-a", {
      pollingIntervalMs: 1000,
      batchSize: 100,
      backoffEnabled: true,
      backoffThreshold: 3,
      backoffMultiplier: 2,
      backoffMaxSeconds: 120,
      enabled: true,
      maxErrors: 5,
      leaderElectionRetryIntervalMs: 15_000
    });
    expect(config.maxErrors).toBe(5);
    expect(config.leaderElectionRetryIntervalMs).toBe(15_000);
  });
});

describe("resolveOverride", () => {
  test("returns the override when present", () => {
    expect(resolveOverride(42, 100)).toBe(42);
  });

  test("falls back to the global default when undefined or null", () => {
    expect(resolveOverride(undefined, 100)).toBe(100);
    expect(resolveOverride(null, 100)).toBe(100);
  });

  test("preserves falsy-but-defined overrides (0, false)", () => {
    expect(resolveOverride(0, 100)).toBe(0);
    expect(resolveOverride(false, true)).toBe(false);
  });
});
