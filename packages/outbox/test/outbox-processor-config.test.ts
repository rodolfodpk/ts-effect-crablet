import { describe, expect, test } from "bun:test";
import { defaultPollingConfig } from "@crablet/event-poller/ProcessorConfig";

const { leaderElectionRetryIntervalMs: _moduleLevel, ...perProcessorDefaults } = defaultPollingConfig;
import { makeOutboxProcessorConfigs, publishersOf } from "../src/internal/OutboxProcessorConfig.ts";
import { defineTopic } from "../src/TopicConfig.ts";
import { makeLogPublisher } from "../src/OutboxPublisher.ts";
import { toKey } from "../src/TopicPublisherPair.ts";
import type { OutboxConfig } from "../src/OutboxConfig.ts";

const kafka = makeLogPublisher("kafka");
const webhook = makeLogPublisher("webhook");
const sns = makeLogPublisher("sns");

const baseConfig: OutboxConfig = {
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
      defineTopic("orders", { publishers: [kafka, webhook] }),
      defineTopic("payments", { publishers: [kafka] })
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
    const [config] = makeOutboxProcessorConfigs(baseConfig, [defineTopic("orders", { publishers: [kafka] })]);
    expect(config!.pollingIntervalMs).toBe(1000);
    expect(config!.batchSize).toBe(100);
    expect(config!.maxErrors).toBe(10);
  });

  test("a publisher's own override wins over the global default", () => {
    const [config] = makeOutboxProcessorConfigs(baseConfig, [
      defineTopic("orders", { publishers: [{ publisher: kafka, pollingIntervalMs: 250 }] })
    ]);
    expect(config!.pollingIntervalMs).toBe(250);
    expect(config!.batchSize).toBe(100);
  });

  test("with no module config at all, every setting is the framework default, and a publisher can still override", () => {
    const [plain, tuned] = makeOutboxProcessorConfigs(undefined, [defineTopic("orders", { publishers: [kafka, { publisher: sns, batchSize: 7 }] })]);
    expect({ ...plain, processorId: undefined }).toEqual({ processorId: undefined, ...perProcessorDefaults });
    expect(tuned!.batchSize).toBe(7);
  });
});

describe("publishersOf", () => {
  test("the processor runs the publishers of its topics, once each", () => {
    expect(publishersOf([defineTopic("orders", { publishers: [kafka, webhook] }), defineTopic("payments", { publishers: [kafka] })])).toEqual([kafka, webhook]);
  });

  test("two different publishers under one name are refused: their progress would be one row", () => {
    expect(() => publishersOf([defineTopic("orders", { publishers: [kafka] }), defineTopic("payments", { publishers: [makeLogPublisher("kafka")] })])).toThrow(
      'two different publishers are named "kafka"'
    );
  });
});
