import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { defaultPollingConfig } from "@crablet/event-poller/ProcessorConfig";

const { leaderElectionRetryIntervalMs: _moduleLevel, ...perProcessorDefaults } = defaultPollingConfig;
import { makeAutomationProcessorConfigs } from "../src/internal/AutomationProcessorConfig.ts";
import { handlerOf } from "./fixtures/handlerOf.ts";
import { testCommand } from "./fixtures/testCommand.ts";
import type { AutomationsConfig } from "../src/AutomationsConfig.ts";
import { noOp } from "../src/AutomationDecision.ts";

const baseConfig: AutomationsConfig = {
  pollingIntervalMs: 1000,
  batchSize: 100,
  backoffEnabled: true,
  backoffThreshold: 3,
  backoffMultiplier: 2,
  backoffMaxSeconds: 120,
  leaderElectionRetryIntervalMs: 30_000,
  maxErrors: 10
};

const fakeHandler = (automationName: string, fields: Parameters<typeof handlerOf>[3] = {}) =>
  handlerOf(
    automationName,
    testCommand,
    () => Effect.succeed([noOp()]),
    { eventTypes: new Set(["Trigger"]), ...fields }
  );

describe("makeAutomationProcessorConfigs", () => {
  test("refuses an automation that handles no event: it would select nothing", () => {
    expect(() => makeAutomationProcessorConfigs(baseConfig, [fakeHandler("idle", { eventTypes: new Set() })])).toThrow(/"idle" handle no event; add \.on\(Event, \.\.\.\)/);
  });

  test("falls back to global AutomationsConfig defaults when a handler has no overrides", () => {
    const [config] = makeAutomationProcessorConfigs(baseConfig, [fakeHandler("send-welcome")]);
    expect(config!.processorId).toBe("send-welcome");
    expect(config!.pollingIntervalMs).toBe(1000);
    expect(config!.batchSize).toBe(100);
    expect(config!.backoffEnabled).toBe(true);
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

  test("with no module config at all, every setting is the framework default, and a handler can still override", () => {
    const [plain, tuned] = makeAutomationProcessorConfigs(undefined, [fakeHandler("a"), fakeHandler("b", { batchSize: 7 })]);
    expect(plain).toEqual({ processorId: "a", ...perProcessorDefaults });
    expect(tuned!.batchSize).toBe(7);
  });

  test("produces one config per handler", () => {
    const configs = makeAutomationProcessorConfigs(baseConfig, [
      fakeHandler("automation-a"),
      fakeHandler("automation-b")
    ]);
    expect(configs.map((c) => c.processorId)).toEqual(["automation-a", "automation-b"]);
  });
});
