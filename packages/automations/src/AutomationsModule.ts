// The automations module's public entry point: `module(...)`, what `@crablet/app` runs, and the types and constants an application names. The processor's
// own `make`/`start` are internal (`./AutomationsProcessor`).
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { ProcessorHandle } from "@crablet/event-poller";
import { builtModule, withProcessSettings, type ProcessSettings } from "@crablet/event-poller/ProcessSettings";
import type { BuiltModule, RunnableModule } from "@crablet/modules/Module";
import { makeAutomationManagementService } from "./AutomationManagementService.ts";
import { makeAutomationsProcessor, startAutomationsProcessor, type AutomationsDeps, type AutomationsRunRequirements } from "./AutomationsProcessor.ts";
export { AUTOMATIONS_LOCK_KEY } from "./AutomationsProcessor.ts";
export type { AutomationsDeps, AutomationsRunRequirements } from "./AutomationsProcessor.ts";

// The automations module, described to the application (`@crablet/app`: `Crablet.modules(Automations.module(...))`). The process's settings (instance id, leader,
// polling default) come from whoever builds it; `config` here overrides the polling default for this module. `describe` says what an automation is for, by its name, as the
// admin API shows it.
export interface AutomationsModuleOptions extends Omit<AutomationsDeps, "instanceId" | "leader"> {
  readonly describe?: ((id: string) => string | undefined) | undefined;
}

export const module = (
  options: AutomationsModuleOptions
): RunnableModule<"automations", SqlClient.SqlClient, AutomationsRunRequirements, ProcessSettings> => {
  const { describe, ...deps } = options;
  const depsOf = (settings: ProcessSettings) => withProcessSettings(deps, settings);
  const built = (handle: ProcessorHandle<unknown>): Effect.Effect<BuiltModule<"automations">, never, SqlClient.SqlClient> =>
    Effect.map(makeAutomationManagementService(handle), (service) => builtModule("automations", handle, service, describe));
  return {
    kind: "automations",
    make: (settings) => Effect.flatMap(makeAutomationsProcessor(depsOf(settings)), built),
    start: (settings) => Effect.flatMap(startAutomationsProcessor(depsOf(settings)), built)
  };
};
