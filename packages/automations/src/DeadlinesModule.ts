import { Effect, type Scope, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { EventStore } from "@crablet/eventstore";
import { CommandAuditStore } from "@crablet/eventstore/CommandAuditStore";
import { DEADLINES_LOCK_KEY, tryAcquireGlobalLeader } from "@crablet/eventstore/Leader";
import { holdSessionOnce, sessionSql } from "@crablet/eventstore/SessionClients";
import { makeEventProcessor, type EventProcessorHandle, type ProcessorHandle } from "@crablet/event-poller";
import * as EventSelection from "@crablet/event-poller/EventSelection";
import { processorConfigOf, resolvePollingConfig, type PollingConfig, type ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import { defaultInstanceId } from "@crablet/event-poller/InstanceId";
import { CommandExecutor } from "@crablet/commands";
import type { Command } from "@crablet/commands/Command";
import { checkDeadlineCommands, DeadlineScheduled } from "@crablet/commands/Deadline";
import type { ExecuteDecision } from "./internal/AutomationEventHandler.ts";
import { makeDeadlineEventHandler } from "./internal/DeadlineEventHandler.ts";
import { makeDeadlineFetcher, makeDeadlineProgressTracker, makeRecordFiring } from "./internal/DeadlineStore.ts";

// The deadlines processor (ADR-0043): it runs each deadline's command once its due time has passed. Deadlines are set by `decide` with `deadline(...)`
// (`@crablet/commands/Deadline`); the append that stores one writes its row in `crablet_deadlines`, which this processor reads by time.
//
//     startDeadlinesProcessor({ commands: [ReleaseUnpaidSubscription] })
//
// It is a processor of the event-poller engine, like the automations, with what differs about deadlines: a fetcher that reads by time, a cursor that
// never moves, no wake-ups (a new event makes nothing due; time does) and so no backoff. It has a leader lock of its own (DEADLINES_LOCK_KEY): one
// instance fires, the others wait, and it fails over independently of the automations. It belongs with the automations role: it fires commands
// through the same executor.

// The processor's one id, as its progress row and the admin API name it.
export const DEADLINES_PROCESSOR_ID = "deadlines";

// Polling and batch, and how many errors in a row make it FAILED; the backoff settings do not apply (it does not back off). The interval is how late a
// deadline can fire after it is due, and an idle poll is one index lookup on the leader: 5 seconds by default, for deadlines in business time.
export type DeadlinesConfig = Partial<Omit<PollingConfig, "backoffEnabled" | "backoffThreshold" | "backoffMultiplier" | "backoffMaxSeconds">>;
export const defaultDeadlinesPollingIntervalMs = 5_000;

export interface DeadlinesDeps {
  // The commands deadlines may name. Each must declare `idempotentBy` (a deadline can fire twice) and have no `personal(...)` field in its input.
  readonly commands: ReadonlyArray<Command<any, any>>;
  readonly config?: DeadlinesConfig;
  readonly instanceId?: string;
}

// Builds the deadlines processor without starting it (a handle for status and the admin API, or a test that drives `start` and `stop` itself).
export const makeDeadlinesProcessor = (
  deps: DeadlinesDeps
): Effect.Effect<
  EventProcessorHandle<ProcessorConfig<string>, string>,
  never,
  SqlClient.SqlClient | CommandExecutor | EventStore | CommandAuditStore
> =>
  Effect.gen(function* () {
    const commands = checkDeadlineCommands(deps.commands);
    const sql = yield* SqlClient.SqlClient;
    const sessionSql_ = yield* sessionSql;
    const commandExecutor = yield* CommandExecutor;
    const eventStore = yield* EventStore;
    const commandAuditStore = yield* CommandAuditStore;

    // As in AutomationsModule.ts: the executor's effect still needs its services, provided here once.
    const executeDecision: ExecuteDecision = (command, input) =>
      commandExecutor.runDecoded(command, input).pipe(
        Effect.provideService(EventStore, eventStore),
        Effect.provideService(CommandAuditStore, commandAuditStore),
        Effect.provideService(SqlClient.SqlClient, sql)
      );

    const recordFiring = makeRecordFiring(sql, eventStore);

    const config = processorConfigOf(DEADLINES_PROCESSOR_ID, {
      pollingIntervalMs: defaultDeadlinesPollingIntervalMs,
      ...deps.config,
      backoffEnabled: false
    });
    const selection = EventSelection.of({ eventTypes: new Set([DeadlineScheduled.type]) });
    const countSession = yield* holdSessionOnce("the deadlines module", 1);

    return yield* makeEventProcessor({
      configs: [config],
      leaderRetryIntervalMs: resolvePollingConfig(deps.config).leaderElectionRetryIntervalMs,
      fetcher: yield* makeDeadlineFetcher(),
      handler: makeDeadlineEventHandler(commands, executeDecision, recordFiring),
      progressTracker: yield* makeDeadlineProgressTracker(),
      selectionOf: () => selection,
      instanceId: deps.instanceId ?? defaultInstanceId(),
      // The first attempt at the lock marks that the module has started: it keeps one session for good, its lock (no LISTEN).
      acquireLeader: Effect.andThen(countSession, tryAcquireGlobalLeader(sessionSql_, DEADLINES_LOCK_KEY)),
      wakeupStream: Stream.never
    });
  });

// Builds the processor and starts it, owned by the Scope: it runs until the scope closes, and closing it stops the loop and releases the lock.
export const startDeadlinesProcessor = (
  deps: DeadlinesDeps
): Effect.Effect<ProcessorHandle, never, SqlClient.SqlClient | CommandExecutor | EventStore | CommandAuditStore | Scope.Scope> =>
  Effect.tap(makeDeadlinesProcessor(deps), (handle) => handle.service.startScoped);
