import { processorConfigOf, type ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import { resolveOverride } from "@crablet/event-poller/ProcessorRuntimeOverrides";
import type { ViewsConfig } from "../ViewsConfig.ts";
import type { ViewSubscription } from "../ViewSubscription.ts";

// Port of internal.ViewProcessorConfig.java's createConfigMap: folds each view's nullable
// per-subscription overrides against the module's global ViewsConfig defaults.
export const makeViewProcessorConfigs = (
  config: ViewsConfig,
  subscriptions: ReadonlyArray<ViewSubscription>
): ReadonlyArray<ProcessorConfig<string>> =>
  subscriptions.map((subscription) =>
    processorConfigOf(subscription.viewName, {
      pollingIntervalMs: resolveOverride(subscription.pollingIntervalMs, config.pollingIntervalMs),
      batchSize: resolveOverride(subscription.batchSize, config.batchSize),
      backoffEnabled: resolveOverride(subscription.backoffEnabled, config.backoffEnabled),
      backoffThreshold: resolveOverride(subscription.backoffThreshold, config.backoffThreshold),
      backoffMultiplier: resolveOverride(subscription.backoffMultiplier, config.backoffMultiplier),
      backoffMaxSeconds: resolveOverride(subscription.backoffMaxSeconds, config.backoffMaxSeconds),
      leaderElectionRetryIntervalMs: config.leaderElectionRetryIntervalMs,
      maxErrors: config.maxErrors,
      enabled: config.enabled
    })
  );
