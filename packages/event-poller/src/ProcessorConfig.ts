import { resolveOverride, type ProcessorRuntimeOverrides } from "./ProcessorRuntimeOverrides.ts";

// How a processor polls, backs off and gives up: the one list of these settings (ADR-0030). The views, automations and outbox modules take
// a `Partial<PollingConfig>` (everything optional, `defaultPollingConfig` fills the rest), and `ProcessorConfig` is this plus the processor's id.
export interface PollingConfig {
  // How long to wait between polls while events keep coming (also the wait when a processor first goes idle).
  readonly pollingIntervalMs: number;
  // The most events handled in one batch (one transaction for a view).
  readonly batchSize: number;
  // After `backoffThreshold` empty polls the wait grows by `backoffMultiplier`, up to `backoffMaxSeconds`. A wake-up ends the wait.
  readonly backoffEnabled: boolean;
  readonly backoffThreshold: number;
  readonly backoffMultiplier: number;
  readonly backoffMaxSeconds: number;
  // Errors in a row before the processor is marked FAILED and stops.
  readonly maxErrors: number;
  // How often a follower tries to take the module's leader lock; bounds the takeover after a crash.
  readonly leaderElectionRetryIntervalMs: number;
}

// The defaults. `backoffMaxSeconds` 10 is the "bounded" profile of docs/guides/operate/run-in-production.md (ADR-0021): an idle processor polls at least every 10 s, so a
// lost wake-up costs at most that.
export const defaultPollingConfig: PollingConfig = {
  pollingIntervalMs: 1000,
  batchSize: 100,
  backoffEnabled: true,
  backoffThreshold: 3,
  backoffMultiplier: 2,
  backoffMaxSeconds: 10,
  maxErrors: 10,
  leaderElectionRetryIntervalMs: 5_000
};

// Configuration of one processor.
export interface ProcessorConfig<I> extends PollingConfig {
  readonly processorId: I;
}

// `defaultPollingConfig`, then what `fields` names. A field that is present but `undefined` does not override the default.
const withDefaults = (fields: Partial<PollingConfig> | undefined): PollingConfig => {
  const merged: Record<string, unknown> = { ...defaultPollingConfig };
  for (const [key, value] of Object.entries(fields ?? {})) if (value !== undefined) merged[key] = value;
  return merged as unknown as PollingConfig;
};

export const processorConfigOf = <I>(processorId: I, fields: Partial<PollingConfig> = {}): ProcessorConfig<I> => ({
  processorId,
  ...withDefaults(fields)
});

// What every module does to build a processor's config: the defaults, then the module's config, then the processor's own overrides (a view's, an automation's, a
// topic publisher's). A `null` or missing override inherits the module's value.
export const processorConfigFrom = <I>(
  processorId: I,
  moduleConfig: Partial<PollingConfig> | undefined,
  overrides: ProcessorRuntimeOverrides = {}
): ProcessorConfig<I> => {
  const base = withDefaults(moduleConfig);
  return {
    processorId,
    ...base,
    pollingIntervalMs: resolveOverride(overrides.pollingIntervalMs, base.pollingIntervalMs),
    batchSize: resolveOverride(overrides.batchSize, base.batchSize),
    backoffEnabled: resolveOverride(overrides.backoffEnabled, base.backoffEnabled),
    backoffThreshold: resolveOverride(overrides.backoffThreshold, base.backoffThreshold),
    backoffMultiplier: resolveOverride(overrides.backoffMultiplier, base.backoffMultiplier),
    backoffMaxSeconds: resolveOverride(overrides.backoffMaxSeconds, base.backoffMaxSeconds)
  };
};
