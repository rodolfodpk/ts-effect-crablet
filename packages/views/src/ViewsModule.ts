// The views module's public entry point: `module(...)`, what `@crablet/app` runs, and the types and constants an application names. The processor's
// own `make`/`start` are internal (`./ViewsProcessor`).
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { ProcessorHandle } from "@crablet/event-poller";
import { builtModule, withProcessSettings, type ProcessSettings } from "@crablet/event-poller/ProcessSettings";
import type { BuiltModule, RunnableModule } from "@crablet/modules/Module";
import { makeViewManagementService } from "./ViewManagementService.ts";
import { makeViewsProcessor, startViewsProcessor, type ViewsDeps, type ViewsRunRequirements } from "./ViewsProcessor.ts";
export { VIEWS_LOCK_KEY } from "./ViewsProcessor.ts";
export type { RunnableView, ViewsDeps, ViewsRunRequirements } from "./ViewsProcessor.ts";

// The views module, described to the application (`@crablet/app`: `Crablet.modules(Views.module(...))`). The process's settings (instance id, leader,
// polling default) come from whoever builds it; `config` here overrides the polling default for this module. `describe` says what a view is for, by its name, as the
// admin API shows it.
export interface ViewsModuleOptions extends Omit<ViewsDeps, "instanceId" | "leader"> {
  readonly describe?: ((id: string) => string | undefined) | undefined;
}

export const module = (
  options: ViewsModuleOptions
): RunnableModule<"views", SqlClient.SqlClient, ViewsRunRequirements, ProcessSettings> => {
  const { describe, ...deps } = options;
  const depsOf = (settings: ProcessSettings) => withProcessSettings(deps, settings);
  const built = (handle: ProcessorHandle<unknown>): Effect.Effect<BuiltModule<"views">, never, SqlClient.SqlClient> =>
    Effect.map(makeViewManagementService(handle), (service) => builtModule("views", handle, service, describe));
  return {
    kind: "views",
    make: (settings) => Effect.flatMap(makeViewsProcessor(depsOf(settings)), built),
    start: (settings) => Effect.flatMap(startViewsProcessor(depsOf(settings)), built)
  };
};
