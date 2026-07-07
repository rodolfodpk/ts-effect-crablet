import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { EventStore } from "@crablet/eventstore";
import { CommandAuditStore } from "@crablet/eventstore/CommandAuditStore";
import { EVENTS_CHANNEL } from "@crablet/eventstore";
import { tryAcquireGlobalLeader, AUTOMATIONS_LOCK_KEY } from "@crablet/eventstore/Leader";
import { wakeupStream } from "@crablet/eventstore/Listen";
import { makeEventProcessor, type EventProcessorHandle } from "@crablet/event-poller";
import type { ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import { makePostgresProgressTracker } from "@crablet/event-poller/PostgresProgressTracker";
import { defaultInstanceId } from "@crablet/event-poller/InstanceId";
import { CommandExecutor } from "@crablet/commands";
import type { AutomationHandler } from "./AutomationHandler.ts";
import type { AutomationsConfig } from "./AutomationsConfig.ts";
import { makeAutomationEventFetcher } from "./internal/AutomationEventFetcher.ts";
import { makeAutomationEventHandler, type ExecuteDecision } from "./internal/AutomationEventHandler.ts";
import { makeAutomationProcessorConfigs } from "./internal/AutomationProcessorConfig.ts";

export interface AutomationsDeps {
  readonly config: AutomationsConfig;
  // See internal/AutomationEventFetcher.ts's primer on this registry's type erasure - each
  // AutomationHandler keeps its own concrete T/E/HE at the call site that builds it; only the
  // heterogeneous list passed here is erased.
  readonly handlers: ReadonlyArray<AutomationHandler<any, any, any>>;
  readonly instanceId?: string;
}

// Port of AutomationsAutoConfiguration + EventProcessorFactory.createProcessor -
// automations-module-specific wiring only. Reuses @crablet/event-poller's generic engine as-is,
// same single-module-wide-leader model views/outbox already use (AUTOMATIONS_LOCK_KEY is one lock
// for the whole module, not one per automation - confirmed against the Java source).
//
// Differs from ViewsModule.ts/OutboxModule.ts in one load-bearing way: makeEventProcessor requires
// `handler: EventHandler<I, unknown, never>` (R discharged to never), but
// CommandExecutorService.execute's returned Effect still requires `EventStore | CommandAuditStore |
// SqlClient.SqlClient` in its R - merely holding the CommandExecutor tag's *value* doesn't remove
// that requirement, since CommandExecutorLive's own implementation does `yield* EventStore`
// internally whenever the returned effect actually runs. So this function yields all four ambient
// services once, then builds `executeDecision` as a closure that discharges that R via
// Effect.provideService before handing the resulting EventHandler off to makeEventProcessor - the
// same "capture ambient deps once, pass concrete values onward" pattern
// ViewProjector.ts's makeTransactionalViewProjector already established for `sql` alone, just
// across three services here instead of one. No event-poller engine changes needed either way.
export const makeAutomationsProcessor = (
  deps: AutomationsDeps
): Effect.Effect<
  EventProcessorHandle<ProcessorConfig<string>, string>,
  never,
  SqlClient.SqlClient | PgClient.PgClient | CommandExecutor | EventStore | CommandAuditStore
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pg = yield* PgClient.PgClient;
    const commandExecutor = yield* CommandExecutor;
    const eventStore = yield* EventStore;
    const commandAuditStore = yield* CommandAuditStore;
    const instanceId = deps.instanceId ?? defaultInstanceId();

    const executeDecision: ExecuteDecision = (commandType, command, handler) =>
      commandExecutor.execute(commandType, command, handler).pipe(
        Effect.provideService(EventStore, eventStore),
        Effect.provideService(CommandAuditStore, commandAuditStore),
        Effect.provideService(SqlClient.SqlClient, sql)
      );

    const progressTracker = yield* makePostgresProgressTracker<string>({
      tableName: "crablet_automation_progress",
      idColumn: "automation_name"
    });
    const fetcher = yield* makeAutomationEventFetcher(deps.handlers);
    const handler = makeAutomationEventHandler(deps.handlers, executeDecision);
    const configs = makeAutomationProcessorConfigs(deps.config, deps.handlers);
    const handlerByName = new Map(deps.handlers.map((h) => [h.automationName, h] as const));

    return yield* makeEventProcessor({
      configs,
      fetcher,
      handler,
      progressTracker,
      // Safe: `configs` above is built 1:1 from `deps.handlers`, so every config.processorId this
      // gets called with is guaranteed to be a key in handlerByName.
      selectionOf: (config) => handlerByName.get(config.processorId)!,
      instanceId,
      acquireLeader: tryAcquireGlobalLeader(sql, AUTOMATIONS_LOCK_KEY),
      wakeupStream: wakeupStream(pg, EVENTS_CHANNEL)
    });
  });
