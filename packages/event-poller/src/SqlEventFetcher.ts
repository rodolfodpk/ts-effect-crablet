import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import type { EventFetcher } from "./EventFetcher.ts";
import type { EventSelection } from "./EventSelection.ts";
import { buildEventSelectionQuery, parseStoredEventRow, type StoredEventRow } from "./internal/sql.ts";

// A generic, selection-keyed EventFetcher against crablet_events/crablet_event_tags - the query
// logic (event types / required-tags / any-of-tags / exact-tags) is the same across every
// consumer module, so this is reusable as-is rather than reimplemented per module in Phase 3
// (mirrors how each Java module's *EventFetcher wraps the same EventSelectionWhereClauseBuilder
// logic; this factory *is* that shared logic, not a per-module wrapper around it).
//
// processorId is intentionally ignored - one fetcher instance is bound to one fixed EventSelection
// at construction time. A Phase-3 module with several processorIds sharing one legacy fetch path
// would construct one of these per processorId (or per distinct selection).
//
// Follows the same "resolve SqlClient once, at factory-construction time" pattern as
// PostgresProgressTracker/EventStoreLive, so the returned EventFetcher's fetchEvents has R = never
// (the SqlClient requirement is discharged by the caller providing a layer around this factory
// Effect, not by every downstream consumer of the fetcher).
export const makeSqlEventFetcher = <I>(
  selection: EventSelection
): Effect.Effect<EventFetcher<I, SqlError, never>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const fetchEvents = (_processorId: I, lastPosition: bigint, batchSize: number) =>
      Effect.gen(function* () {
        const query = buildEventSelectionQuery(selection, lastPosition, batchSize);
        const rows = yield* sql.unsafe<StoredEventRow>(query.sql, query.params);
        return rows.map(parseStoredEventRow);
      });

    const fetcher: EventFetcher<I, SqlError, never> = { fetchEvents };
    return fetcher;
  });
