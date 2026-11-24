// The outbox module's public entry point: `module(...)`, what `@crablet/app` runs, and the types and constants an application names. The processor's
// own `make`/`start` are internal (`./OutboxProcessor`).
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import type { ProcessorHandle } from "@crablet/event-poller";
import { builtModule, withProcessSettings, type ProcessSettings } from "@crablet/event-poller/ProcessSettings";
import type { BuiltModule, RunnableModule } from "@crablet/modules/Module";
import { makeOutboxManagementService } from "./OutboxManagementService.ts";
import { makeOutboxProcessor, startChecked, type OutboxDeps, type OutboxRunRequirements, type PublishersFor } from "./OutboxProcessor.ts";
import { OutboxPublishers } from "./OutboxPublisher.ts";
import type { TopicConfig } from "./TopicConfig.ts";
export { OUTBOX_LOCK_KEY } from "./OutboxProcessor.ts";
export type { OutboxDeps, OutboxRunRequirements, PublishersFor, OutboxStartDeps } from "./OutboxProcessor.ts";

// The outbox module, described to the application (`@crablet/app`: `Crablet.modules(Outbox.module(...))`). The process's settings (instance id, leader,
// polling default) come from whoever builds it; `config` here overrides the polling default for this module. `describe` says what a (topic, publisher) pair is for, by its key, as the
// admin API shows it.
export interface OutboxModuleOptions extends Omit<OutboxDeps, "instanceId" | "leader"> {
  readonly describe?: ((id: string) => string | undefined) | undefined;
}

export const module = (
  options: OutboxModuleOptions
): RunnableModule<"outbox", SqlClient.SqlClient, OutboxRunRequirements, ProcessSettings> => {
  const { describe, ...deps } = options;
  const depsOf = (settings: ProcessSettings) => withProcessSettings(deps, settings);
  const built = (handle: ProcessorHandle<unknown>): Effect.Effect<BuiltModule<"outbox">, never, SqlClient.SqlClient> =>
    Effect.map(makeOutboxManagementService(handle), (service) => builtModule("outbox", handle, service, describe));
  return {
    kind: "outbox",
    make: (settings) => Effect.flatMap(makeOutboxProcessor(depsOf(settings)), built),
    start: (settings) => Effect.flatMap(makeOutboxProcessor(depsOf(settings)), (handle) => Effect.as(startChecked(handle, deps.topics), handle)).pipe(Effect.flatMap(built))
  };
};

// The publishers a process that runs the outbox module provides, one per name its topics give (a missing name does not compile): the layer `Crablet.processors`
// needs when the declaration has an outbox. A process that only catalogs the modules needs none. Given for other topics than the module's, a missing name
// fails the module's start, naming it.
export const publishers = <const T extends ReadonlyArray<TopicConfig>>(_topics: T, given: PublishersFor<T>): Layer.Layer<OutboxPublishers> =>
  Layer.succeed(OutboxPublishers, given);
