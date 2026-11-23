import { Effect, type Scope, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { EVENTS_CHANNEL, Wakeups } from "@crablet/eventstore";
import { tryAcquireGlobalLeader, type LeaderOptions } from "@crablet/eventstore/Leader";
import { wakeupStream } from "@crablet/eventstore/Listen";
import { holdSessionOnce, sessionPg, sessionSql } from "@crablet/eventstore/SessionClients";
import { checkIdleInTransactionOnce } from "@crablet/eventstore/ServerSettings";
import { makeEventProcessor, type ProcessorHandle } from "@crablet/event-poller";
import { resolvePollingConfig } from "@crablet/event-poller/ProcessorConfig";
import { makePostgresProgressTracker } from "@crablet/event-poller/PostgresProgressTracker";
import { makeSqlEventFetcher } from "@crablet/event-poller/SqlEventFetcher";
import { defaultInstanceId } from "@crablet/event-poller/InstanceId";
import { CommandExecutor } from "@crablet/commands";
import { withOverridesByName, type ProcessorRuntimeOverrides } from "@crablet/event-poller/ProcessorRuntimeOverrides";
import type { EventHandler } from "@crablet/event-poller/EventHandler";
import type { AutomationHandler } from "./AutomationHandler.ts";
import type { AutomationsConfig } from "./AutomationsConfig.ts";
import { makeAutomationEventHandler, type ExecuteDecision } from "./internal/AutomationEventHandler.ts";
import { makeAutomationProcessorConfigs } from "./internal/AutomationProcessorConfig.ts";
import { builtModule, withProcessSettings, type ProcessSettings } from "@crablet/event-poller/ProcessSettings";
import type { BuiltModule, RunnableModule } from "@crablet/modules/Module";
import { makeAutomationManagementService } from "./AutomationManagementService.ts";

// The module's advisory lock: one leader per database at a time (ADR-0022). Its value never changes: in a rolling deploy, old and new versions take the
// same lock, so they never lead together. The key belongs to the module, not to the event store, so a new kind of module needs no change there.
export const AUTOMATIONS_LOCK_KEY = 4856221667890123458n;

export interface AutomationsDeps {
  // Optional: what is left out takes its value from `defaultPollingConfig` (ADR-0030).
  readonly config?: AutomationsConfig | undefined;
  // The automations, each built with `defineAutomation(...).on(...)`. `AutomationHandler<any, any, any>`: a heterogeneous list, each with its own
  // command type T, is type-erased here - each keeps its own concrete T/E/HE where it is defined. The wiring below reads only the
  // EventSelection/automationName fields, which don't depend on T; T matters only to the per-decision dispatch (internal/AutomationEventHandler.ts).
  readonly automations: ReadonlyArray<AutomationHandler<any, any, any>>;
  // Per-automation polling, batch and backoff, by automation name: deployment settings, kept out of the automation's definition.
  readonly overrides?: Readonly<Record<string, ProcessorRuntimeOverrides>> | undefined;
  readonly instanceId?: string | undefined;
  // How the module's leader checks its lock and how long the server keeps a silent leader's session (`serverIdleTimeout`, ADR-0045). Default: the
  // defaults of `LeaderOptions`.
  readonly leader?: LeaderOptions | undefined;
}

// Automations-module-specific wiring only. Reuses @crablet/event-poller's generic engine as-is,
// same single-module-wide-leader model views/outbox already use (AUTOMATIONS_LOCK_KEY is one lock
// for the whole module, not one per automation).
//
// Built needing only the SQL client (decision V1): a handle that is not running is read and controlled through the database. What running needs (the
// `CommandExecutor` its commands go through, the `PgClient` its wake-ups LISTEN on) is the handle's run requirement, given where it starts.
export type AutomationsRunRequirements = CommandExecutor | PgClient.PgClient;

export const makeAutomationsProcessor = (
  deps: AutomationsDeps
): Effect.Effect<ProcessorHandle<AutomationsRunRequirements>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The leader's lock and LISTEN: the session clients when the application provides them (behind a pooler in transaction mode), else the ones above.
    const sessionSql_ = yield* sessionSql;
    const instanceId = deps.instanceId ?? defaultInstanceId();

    const executeDecision: ExecuteDecision<CommandExecutor> = (command, input) =>
      Effect.flatMap(CommandExecutor, (executor) => executor.runDecoded(command, input));

    const progressTracker = yield* makePostgresProgressTracker<string>({
      tableName: "crablet_automation_progress",
      idColumn: "automation_name"
    });
    const fetcher = yield* makeSqlEventFetcher();
    const automations = withOverridesByName("automations", deps.automations, (a) => a.automationName, deps.overrides ?? {});
    const handler: EventHandler<string, unknown, AutomationsRunRequirements> = makeAutomationEventHandler(automations, executeDecision);
    const configs = makeAutomationProcessorConfigs(deps.config, automations);
    const handlerByName = new Map(automations.map((h) => [h.automationName, h] as const));

    const wakeups = yield* Effect.service(Wakeups);
    const started = Effect.andThen(yield* holdSessionOnce("the automations module"), checkIdleInTransactionOnce(sql));

    return yield* makeEventProcessor({
      configs,
      leaderRetryIntervalMs: resolvePollingConfig(deps.config).leaderElectionRetryIntervalMs,
      fetcher,
      handler,
      progressTracker,
      // Safe: `configs` above is built 1:1 from `automations`, so every config.processorId this
      // gets called with is guaranteed to be a key in handlerByName.
      selectionOf: (config) => handlerByName.get(config.processorId)!,
      instanceId,
      // The first attempt at the lock marks that the module has started: the process's one lock session is counted by the first module (its LISTEN is on the process's LISTEN connection, not in the pool); and it checks, once per process, that the server ends a vanished pod's transaction (ServerSettings).
      acquireLeader: Effect.andThen(started, tryAcquireGlobalLeader(sessionSql_, AUTOMATIONS_LOCK_KEY, deps.leader)),
      wakeupStream: wakeups === "off" ? Stream.never : Stream.unwrap(Effect.map(sessionPg, (pg) => wakeupStream(pg, EVENTS_CHANNEL)))
    });
  });

// Builds the processor and starts it, owned by the Scope: it runs until the scope closes, and closing it stops the loops and releases the
// leader lock. What an application uses. `makeAutomationsProcessor` builds without starting (a handle for status, a test that drives `start`/`stop` itself).
export const startAutomationsProcessor = (
  deps: AutomationsDeps
): Effect.Effect<ProcessorHandle<AutomationsRunRequirements>, never, SqlClient.SqlClient | AutomationsRunRequirements | Scope.Scope> =>
  Effect.tap(makeAutomationsProcessor(deps), (handle) => handle.service.startScoped);

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
