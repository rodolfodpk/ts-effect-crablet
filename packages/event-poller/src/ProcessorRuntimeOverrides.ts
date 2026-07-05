// Port of com.crablet.eventpoller.processor.ProcessorRuntimeOverrides /
// ProcessorRuntimeOverrideResolver. Java needs six per-field static resolve methods because Java
// generics can't express one function covering every field; TS's generics make one function
// sufficient. `undefined`/`null` means "inherit the module-wide default".
//
// Consumed by Phase 3 per-module config types (ViewSubscription, AutomationHandler, etc.) when
// building a ProcessorConfig<I> - event-poller itself doesn't call this internally.
export interface ProcessorRuntimeOverrides {
  readonly pollingIntervalMs?: number | null;
  readonly batchSize?: number | null;
  readonly backoffEnabled?: boolean | null;
  readonly backoffThreshold?: number | null;
  readonly backoffMultiplier?: number | null;
  readonly backoffMaxSeconds?: number | null;
}

export const resolveOverride = <T>(override: T | undefined | null, globalDefault: T): T =>
  override ?? globalDefault;
