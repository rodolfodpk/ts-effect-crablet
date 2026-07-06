import { describe, expect, test } from "bun:test";
import { makeOutboxProcessorConfigs } from "../src/internal/OutboxProcessorConfig.ts";
import { topicConfigOf } from "../src/TopicConfig.ts";
import { toKey } from "../src/TopicPublisherPair.ts";
import type { OutboxConfig } from "../src/OutboxConfig.ts";

const baseConfig: OutboxConfig = {
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

describe("makeOutboxProcessorConfigs", () => {
  test("cross-joins each topic's publishers into one config per pair", () => {
    const configs = makeOutboxProcessorConfigs(baseConfig, [
      topicConfigOf("orders", { publishers: ["kafka", "webhook"] }),
      topicConfigOf("payments", { publishers: ["kafka"] })
    ]);

    expect(configs.map((c) => c.processorId).sort()).toEqual(
      [
        toKey({ topic: "orders", publisher: "kafka" }),
        toKey({ topic: "orders", publisher: "webhook" }),
        toKey({ topic: "payments", publisher: "kafka" })
      ].sort()
    );
  });

  test("falls back to global OutboxConfig defaults when a publisher has no overrides", () => {
    const [config] = makeOutboxProcessorConfigs(baseConfig, [topicConfigOf("orders", { publishers: ["kafka"] })]);
    expect(config!.pollingIntervalMs).toBe(1000);
    expect(config!.batchSize).toBe(100);
    expect(config!.maxErrors).toBe(10);
  });

  test("a publisher's own override wins over the global default", () => {
    const [config] = makeOutboxProcessorConfigs(baseConfig, [
      topicConfigOf("orders", { publishers: [{ name: "kafka", pollingIntervalMs: 250 }] })
    ]);
    expect(config!.pollingIntervalMs).toBe(250);
    expect(config!.batchSize).toBe(100);
  });
});
