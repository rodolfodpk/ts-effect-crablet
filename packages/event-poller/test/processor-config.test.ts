import { describe, expect, test } from "bun:test";
import { defaultPollingConfig, processorConfigFrom, processorConfigOf, resolvePollingConfig } from "../src/ProcessorConfig.ts";

// What a processor carries: the polling settings without the module-level leader retry.
const { leaderElectionRetryIntervalMs: _moduleLevel, ...perProcessorDefaults } = defaultPollingConfig;
import { resolveOverride } from "../src/ProcessorRuntimeOverrides.ts";

describe("processorConfigOf", () => {
  test("supplies a default for maxErrors when omitted", () => {
    const config = processorConfigOf("view-a", {
      pollingIntervalMs: 1000,
      batchSize: 100,
      backoffEnabled: true,
      backoffThreshold: 3,
      backoffMultiplier: 2,
      backoffMaxSeconds: 120,
    });
    expect(config.maxErrors).toBe(10);
    expect(config.processorId).toBe("view-a");
  });

  test("allows overriding the defaulted field", () => {
    const config = processorConfigOf("view-a", {
      pollingIntervalMs: 1000,
      batchSize: 100,
      backoffEnabled: true,
      backoffThreshold: 3,
      backoffMultiplier: 2,
      backoffMaxSeconds: 120,
      maxErrors: 5
    });
    expect(config.maxErrors).toBe(5);
  });
});

describe("defaultPollingConfig", () => {
  test("is the one set of defaults: poll every second in batches of 100, back off to 10 s, 10 errors, retry the leader lock every 5 s", () => {
    expect(defaultPollingConfig).toEqual({
      pollingIntervalMs: 1000,
      batchSize: 100,
      backoffEnabled: true,
      backoffThreshold: 3,
      backoffMultiplier: 2,
      backoffMaxSeconds: 10,
      maxErrors: 10,
      leaderElectionRetryIntervalMs: 5_000
    });
  });

  test("processorConfigOf with nothing but an id is all defaults; what it is given wins; an undefined field does not erase a default", () => {
    expect(processorConfigOf("p")).toEqual({ processorId: "p", ...perProcessorDefaults });
    expect(processorConfigOf("p", { batchSize: 5 }).batchSize).toBe(5);
    expect(processorConfigOf("p", { batchSize: undefined }).batchSize).toBe(100);
  });
});

describe("processorConfigFrom", () => {
  test("no module config and no overrides: the defaults", () => {
    expect(processorConfigFrom("p", undefined)).toEqual({ processorId: "p", ...perProcessorDefaults });
  });

  test("the module's config wins over the defaults, and names only what it changes", () => {
    const c = processorConfigFrom("p", { pollingIntervalMs: 200, maxErrors: 3 });
    expect([c.pollingIntervalMs, c.maxErrors]).toEqual([200, 3]);
    expect([c.batchSize, c.backoffMaxSeconds]).toEqual([100, 10]);
  });

  test("a processor's own override wins over the module's config; null and undefined inherit; 0 and false are real overrides", () => {
    const c = processorConfigFrom("p", { pollingIntervalMs: 200, batchSize: 50, backoffEnabled: true }, { pollingIntervalMs: 25, batchSize: null, backoffEnabled: false, backoffThreshold: 0 });
    expect([c.pollingIntervalMs, c.batchSize, c.backoffEnabled, c.backoffThreshold]).toEqual([25, 50, false, 0]);
  });

  test("the leader retry is a module setting: resolvePollingConfig has it, a processor's config does not", () => {
    expect(resolvePollingConfig(undefined).leaderElectionRetryIntervalMs).toBe(5_000);
    expect(resolvePollingConfig({ leaderElectionRetryIntervalMs: 1000 }).leaderElectionRetryIntervalMs).toBe(1000);
    expect("leaderElectionRetryIntervalMs" in processorConfigFrom("p", { leaderElectionRetryIntervalMs: 1000 })).toBe(false);
  });

  test("maxErrors belongs to the module: a processor cannot override it", () => {
    const c = processorConfigFrom("p", { maxErrors: 3 }, { maxErrors: 99 } as never);
    expect(c.maxErrors).toBe(3);
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
