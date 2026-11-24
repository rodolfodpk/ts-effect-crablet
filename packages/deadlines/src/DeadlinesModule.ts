// The deadlines module's public entry point: `module(...)`, what `@crablet/app` runs, and the types and constants an application names. The processor's
// own `make`/`start` are internal (`./DeadlinesProcessor`).
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { ProcessorHandle } from "@crablet/event-poller";
import { builtModule, withProcessSettings, type ProcessSettings } from "@crablet/event-poller/ProcessSettings";
import type { BuiltModule, RunnableModule } from "@crablet/modules/Module";
import { makeDeadlinesManagementService } from "./DeadlinesManagementService.ts";
import { makeDeadlinesProcessor, startDeadlinesProcessor, type DeadlinesDeps, type DeadlinesRunRequirements } from "./DeadlinesProcessor.ts";
export { DEADLINES_LOCK_KEY, DEADLINES_PROCESSOR_ID, defaultDeadlinesPollingIntervalMs, defaultDeadlineFireTimeoutMs } from "./DeadlinesProcessor.ts";
export type { DeadlinesConfig, DeadlinesDeps, DeadlinesRunRequirements } from "./DeadlinesProcessor.ts";

// The deadlines module, described to the application (`@crablet/app`: `Crablet.modules(Deadlines.module(...))`). The process's settings (instance id, leader,
// polling default) come from whoever builds it; `config` here overrides the polling default for this module. `describe` says what the deadlines processor is for, as the
// admin API shows it.
export interface DeadlinesModuleOptions extends Omit<DeadlinesDeps, "instanceId" | "leader"> {
  readonly describe?: ((id: string) => string | undefined) | undefined;
}

export const module = (
  options: DeadlinesModuleOptions
): RunnableModule<"deadlines", SqlClient.SqlClient, DeadlinesRunRequirements, ProcessSettings> => {
  const { describe, ...deps } = options;
  const depsOf = (settings: ProcessSettings) => withProcessSettings(deps, settings);
  const built = (handle: ProcessorHandle<unknown>): Effect.Effect<BuiltModule<"deadlines">, never, SqlClient.SqlClient> =>
    Effect.map(makeDeadlinesManagementService(handle), (service) => builtModule("deadlines", handle, service, describe));
  return {
    kind: "deadlines",
    make: (settings) => Effect.flatMap(makeDeadlinesProcessor(depsOf(settings)), built),
    start: (settings) => Effect.flatMap(startDeadlinesProcessor(depsOf(settings)), built)
  };
};
