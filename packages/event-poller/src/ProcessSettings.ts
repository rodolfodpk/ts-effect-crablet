import type { LeaderOptions } from "@crablet/eventstore/Leader";
import type { BuiltModule } from "@crablet/modules/Module";
import type { ProcessorManagementService } from "@crablet/modules";
import type { PollingConfig, PollingSettings } from "./ProcessorConfig.ts";
import type { ProcessorHandle } from "./EventProcessor.ts";

// What one process gives every module it builds: one instance id, one set of leader settings and one polling default per process (a module's own config
// overrides the polling). The modules' descriptors take these (`ModuleDescriptor<Kind, MakeR, ProcessSettings>`), and `@crablet/app` fills them.
export interface ProcessSettings {
  readonly instanceId: string;
  readonly leader?: LeaderOptions | undefined;
  readonly polling?: PollingSettings | undefined;
}

// Every polling setting, by name: what a module's config may override in the process's default.
const pollingKeys = [
  "pollingIntervalMs",
  "batchSize",
  "backoffEnabled",
  "backoffThreshold",
  "backoffMultiplier",
  "backoffMaxSeconds",
  "maxErrors",
  "leaderElectionRetryIntervalMs"
] as const satisfies ReadonlyArray<keyof PollingConfig>;

// The process's polling default with the module's own settings over it. A setting the module leaves `undefined` means "the default" (the repository's
// `x?: T | undefined` convention), so it keeps the process's value instead of erasing it.
export const pollingOver = (process: PollingSettings | undefined, own: PollingSettings | undefined): PollingSettings => {
  const merged: { -readonly [K in keyof PollingConfig]?: PollingConfig[K] | undefined } = { ...process };
  const take = <K extends keyof PollingConfig>(key: K): void => {
    const value = own?.[key];
    if (value !== undefined) merged[key] = value;
  };
  pollingKeys.forEach(take);
  return merged;
};

// A module's dependencies with the process's settings: the module's config over the process's polling default, the process's instance id and leader settings.
export const withProcessSettings = <D extends { readonly config?: PollingSettings | undefined }>(
  deps: D,
  settings: ProcessSettings
): D & { readonly instanceId: string; readonly leader: LeaderOptions | undefined } => ({
  ...deps,
  config: { ...deps.config, ...pollingOver(settings.polling, deps.config) },
  instanceId: settings.instanceId,
  leader: settings.leader
});

// A built module, as the application process holds it: its management service as the source the admin API lists, and whether this process leads it.
export const builtModule = <Kind extends string>(
  kind: Kind,
  handle: ProcessorHandle<unknown>,
  service: ProcessorManagementService<string>,
  describe: ((id: string) => string | undefined) | undefined
): BuiltModule<Kind> => ({ kind, source: { kind, service, describe }, isLeader: handle.isLeader });

