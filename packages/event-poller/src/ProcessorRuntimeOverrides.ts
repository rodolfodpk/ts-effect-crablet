import type { PollingConfig } from "./ProcessorConfig.ts";

// Per-processor runtime overrides, resolved against module-wide defaults by one generic function.
// `undefined`/`null` means "inherit the module-wide default".
//
// Consumed by `processorConfigFrom` (ProcessorConfig.ts), which every module uses to build a ProcessorConfig<I> from the module's config and these.
// The settings a single processor can override. Derived from `PollingConfig` so a new setting is added in one place (`maxErrors` and the leader retry belong to the
// module, not to one processor).
type Overridable = "pollingIntervalMs" | "batchSize" | "backoffEnabled" | "backoffThreshold" | "backoffMultiplier" | "backoffMaxSeconds";
export type ProcessorRuntimeOverrides = { readonly [K in Overridable]?: PollingConfig[K] | null };

export const resolveOverride = <T>(override: T | undefined | null, globalDefault: T): T =>
  override ?? globalDefault;
