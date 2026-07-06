import { processorConfigOf, type ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import { resolveOverride } from "@crablet/event-poller/ProcessorRuntimeOverrides";
import type { AutomationsConfig } from "../AutomationsConfig.ts";
import type { AutomationHandler } from "../AutomationHandler.ts";

// Port of internal.AutomationProcessorConfig.java's createConfigMap: folds each automation's
// nullable per-handler overrides against the module's global AutomationsConfig defaults - one
// ProcessorConfig<string> per AutomationHandler, same single-key shape ViewProcessorConfig.ts uses
// (not outbox's cross-join, since an automation has no secondary "publisher"-like dimension).
export const makeAutomationProcessorConfigs = (
  config: AutomationsConfig,
  // See AutomationEventFetcher.ts's primer on this registry's type erasure.
  handlers: ReadonlyArray<AutomationHandler<any, any, any>>
): ReadonlyArray<ProcessorConfig<string>> =>
  handlers.map((handler) =>
    processorConfigOf(handler.automationName, {
      pollingIntervalMs: resolveOverride(handler.pollingIntervalMs, config.pollingIntervalMs),
      batchSize: resolveOverride(handler.batchSize, config.batchSize),
      backoffEnabled: resolveOverride(handler.backoffEnabled, config.backoffEnabled),
      backoffThreshold: resolveOverride(handler.backoffThreshold, config.backoffThreshold),
      backoffMultiplier: resolveOverride(handler.backoffMultiplier, config.backoffMultiplier),
      backoffMaxSeconds: resolveOverride(handler.backoffMaxSeconds, config.backoffMaxSeconds),
      leaderElectionRetryIntervalMs: config.leaderElectionRetryIntervalMs,
      maxErrors: config.maxErrors,
      enabled: config.enabled
    })
  );
