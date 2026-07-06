import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventFetcher } from "@crablet/event-poller/EventFetcher";
import { makeSqlEventFetcher } from "@crablet/event-poller/SqlEventFetcher";
import type { AutomationHandler } from "../AutomationHandler.ts";

// One makeSqlEventFetcher instance per automation (each bound to that automation's own
// EventSelection), dispatched by automationName - reuses event-poller's shared selection-keyed
// fetcher logic as-is, same reuse ViewEventFetcher.ts already established for views rather than
// duplicating Java's internal.AutomationEventFetcher's own SQL-building wrapper.
// `AutomationHandler<any, any, any>`: a heterogeneous registry of automations, each with its own
// command type T, is inherently type-erased at this boundary - same as Java's Object-command
// erasure, just confined to this internal wiring file rather than leaking into the public
// AutomationHandler<T, E, HE> API. T only matters to the caller who built each handler and to
// AutomationDispatcher's per-decision dispatch (AutomationEventHandler.ts); this fetcher only ever
// reads the EventSelection/automationName fields, which don't depend on T at all.
export const makeAutomationEventFetcher = (
  handlers: ReadonlyArray<AutomationHandler<any, any, any>>
): Effect.Effect<EventFetcher<string, SqlError, never>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const fetchers = new Map<string, EventFetcher<string, SqlError, never>>();
    for (const handler of handlers) {
      fetchers.set(handler.automationName, yield* makeSqlEventFetcher<string>(handler));
    }

    const fetchEvents = (
      automationName: string,
      lastPosition: bigint,
      batchSize: number
    ): Effect.Effect<ReadonlyArray<StoredEvent>, SqlError, never> => {
      const fetcher = fetchers.get(automationName);
      return fetcher
        ? fetcher.fetchEvents(automationName, lastPosition, batchSize)
        : Effect.die(new Error(`Unknown automation: ${automationName}`));
    };

    return { fetchEvents };
  });
