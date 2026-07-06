import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as CD from "@crablet/commands/CommandDecision";
import { makeAutomationProcessorConfigs } from "../src/internal/AutomationProcessorConfig.ts";
import { automationHandlerOf } from "../src/AutomationHandler.ts";
import type { AutomationsConfig } from "../src/AutomationsConfig.ts";
import { noOp } from "../src/AutomationDecision.ts";

const baseConfig: AutomationsConfig = {
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

const fakeHandler = (automationName: string, fields: Parameters<typeof automationHandlerOf>[3] = {}) =>
  automationHandlerOf(
    automationName,
    (_command: unknown) => Effect.succeed(CD.noOp()),
    () => Effect.succeed([noOp()]),
    fields
  );

describe("makeAutomationProcessorConfigs", () => {
  test("falls back to global AutomationsConfig defaults when a handler has no overrides", () => {
    const [config] = makeAutomationProcessorConfigs(baseConfig, [fakeHandler("send-welcome")]);
    expect(config!.processorId).toBe("send-welcome");
    expect(config!.pollingIntervalMs).toBe(1000);
    expect(config!.batchSize).toBe(100);
    expect(config!.backoffEnabled).toBe(true);
    expect(config!.enabled).toBe(true);
    expect(config!.maxErrors).toBe(10);
  });

  test("a handler's own override wins over the global default", () => {
    const [config] = makeAutomationProcessorConfigs(baseConfig, [
      fakeHandler("send-welcome", { pollingIntervalMs: 250, backoffEnabled: false })
    ]);
    expect(config!.pollingIntervalMs).toBe(250);
    expect(config!.backoffEnabled).toBe(false);
    // Non-overridden fields still fall back to the global default.
    expect(config!.batchSize).toBe(100);
  });

  test("produces one config per handler", () => {
    const configs = makeAutomationProcessorConfigs(baseConfig, [
      fakeHandler("automation-a"),
      fakeHandler("automation-b")
    ]);
    expect(configs.map((c) => c.processorId)).toEqual(["automation-a", "automation-b"]);
  });
});
