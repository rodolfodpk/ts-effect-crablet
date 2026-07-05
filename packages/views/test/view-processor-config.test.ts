import { describe, expect, test } from "bun:test";
import { makeViewProcessorConfigs } from "../src/internal/ViewProcessorConfig.ts";
import { viewSubscriptionOf } from "../src/ViewSubscription.ts";
import type { ViewsConfig } from "../src/ViewsConfig.ts";

const baseConfig: ViewsConfig = {
  enabled: true,
  pollingIntervalMs: 1000,
  batchSize: 100,
  backoffEnabled: true,
  backoffThreshold: 3,
  backoffMultiplier: 2,
  backoffMaxSeconds: 120,
  leaderElectionRetryIntervalMs: 30_000,
  maxErrors: 10
};

describe("makeViewProcessorConfigs", () => {
  test("falls back to global ViewsConfig defaults when a subscription has no overrides", () => {
    const [config] = makeViewProcessorConfigs(baseConfig, [viewSubscriptionOf("wallet-view")]);
    expect(config!.processorId).toBe("wallet-view");
    expect(config!.pollingIntervalMs).toBe(1000);
    expect(config!.batchSize).toBe(100);
    expect(config!.backoffEnabled).toBe(true);
    expect(config!.enabled).toBe(true);
    expect(config!.maxErrors).toBe(10);
  });

  test("a subscription's own override wins over the global default", () => {
    const [config] = makeViewProcessorConfigs(baseConfig, [
      viewSubscriptionOf("wallet-view", { pollingIntervalMs: 250, backoffEnabled: false })
    ]);
    expect(config!.pollingIntervalMs).toBe(250);
    expect(config!.backoffEnabled).toBe(false);
    // Non-overridden fields still fall back to the global default.
    expect(config!.batchSize).toBe(100);
  });

  test("produces one config per subscription", () => {
    const configs = makeViewProcessorConfigs(baseConfig, [
      viewSubscriptionOf("view-a"),
      viewSubscriptionOf("view-b")
    ]);
    expect(configs.map((c) => c.processorId)).toEqual(["view-a", "view-b"]);
  });
});
