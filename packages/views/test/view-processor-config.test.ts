import { describe, expect, test } from "bun:test";
import { defaultPollingConfig } from "@crablet/event-poller/ProcessorConfig";

const { leaderElectionRetryIntervalMs: _moduleLevel, ...perProcessorDefaults } = defaultPollingConfig;
import { makeViewProcessorConfigs } from "../src/internal/ViewProcessorConfig.ts";
import { viewSubscriptionOf } from "../src/ViewSubscription.ts";
import type { ViewsConfig } from "../src/ViewsConfig.ts";

const baseConfig: ViewsConfig = {
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

  test("with no module config at all, every setting is the framework default, and a subscription can still override", () => {
    const [plain, tuned] = makeViewProcessorConfigs(undefined, [viewSubscriptionOf("a"), viewSubscriptionOf("b", { batchSize: 7 })]);
    expect(plain).toEqual({ processorId: "a", ...perProcessorDefaults });
    expect(tuned!.batchSize).toBe(7);
  });

  test("a partial module config changes only what it names", () => {
    const [config] = makeViewProcessorConfigs({ backoffMaxSeconds: 120 }, [viewSubscriptionOf("a")]);
    expect(config!.backoffMaxSeconds).toBe(120);
    expect(config!.pollingIntervalMs).toBe(defaultPollingConfig.pollingIntervalMs);
  });

  test("produces one config per subscription", () => {
    const configs = makeViewProcessorConfigs(baseConfig, [
      viewSubscriptionOf("view-a"),
      viewSubscriptionOf("view-b")
    ]);
    expect(configs.map((c) => c.processorId)).toEqual(["view-a", "view-b"]);
  });
});
