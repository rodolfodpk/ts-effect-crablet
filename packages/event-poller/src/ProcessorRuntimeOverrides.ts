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

// Applies per-processor overrides given by name (a view's or an automation's), and refuses a name that is not in the list: a typo would
// otherwise be ignored in silence.
export const withOverridesByName = <A extends ProcessorRuntimeOverrides>(
  module: string,
  items: ReadonlyArray<A>,
  nameOf: (item: A) => string,
  overrides: Readonly<Record<string, ProcessorRuntimeOverrides>>
): ReadonlyArray<A> => {
  const names = new Set(items.map(nameOf));
  const unknown = Object.keys(overrides).filter((name) => !names.has(name));
  if (unknown.length > 0) throw new Error(`${module}: overrides name ${unknown.map((n) => `"${n}"`).join(", ")}, which is not in the list`);
  return items.map((item) => {
    const given = overrides[nameOf(item)];
    return given === undefined ? item : { ...item, ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) };
  });
};
