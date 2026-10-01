import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventFetcher } from "@crablet/event-poller/EventFetcher";
import type { ProgressCursor } from "@crablet/event-poller/ProgressCursor";
import { makeSqlEventFetcher } from "@crablet/event-poller/SqlEventFetcher";
import type { ViewSubscription } from "../ViewSubscription.ts";

// One makeSqlEventFetcher instance per view (each bound to that view's own EventSelection),
// dispatched by viewName - reuses event-poller's shared selection-keyed fetcher logic as-is rather
// than duplicating SQL-building code.
export const makeViewEventFetcher = (
  subscriptions: ReadonlyArray<ViewSubscription>
): Effect.Effect<EventFetcher<string, SqlError, never>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const fetchers = new Map<string, EventFetcher<string, SqlError, never>>();
    for (const subscription of subscriptions) {
      fetchers.set(subscription.viewName, yield* makeSqlEventFetcher<string>(subscription));
    }

    const fetchEvents = (
      viewName: string,
      cursor: ProgressCursor,
      batchSize: number
    ): Effect.Effect<ReadonlyArray<StoredEvent>, SqlError, never> => {
      const fetcher = fetchers.get(viewName);
      return fetcher
        ? fetcher.fetchEvents(viewName, cursor, batchSize)
        : Effect.die(new Error(`Unknown view: ${viewName}`));
    };

    return { fetchEvents };
  });
