import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { EventFetcher } from "./EventFetcher.ts";
import type { EventSelection } from "./EventSelection.ts";
import type { ProgressCursor } from "./ProgressCursor.ts";
import { buildEventSelectionQuery, buildPendingSelectionQuery, parseStoredEventRow, type SelectionQueryOptions, type StoredEventRow } from "./internal/sql.ts";

export { buildReadCheckQuery } from "./internal/sql.ts";
export type { SelectionQueryOptions } from "./internal/sql.ts";

// The EventFetcher against crablet_events/crablet_event_tag_keys - the query logic (event types /
// required-tags / any-of-tags / exact-tags) is the same across every consumer module, and the
// selection comes with each fetch, so one instance serves every processor of a module.
//
// Follows the same "resolve SqlClient once, at factory-construction time" pattern as
// PostgresProgressTracker/EventStoreLive, so the returned EventFetcher's fetchEvents has R = never
// (the SqlClient requirement is discharged by the caller providing a layer around this factory
// Effect, not by every downstream consumer of the fetcher).
export const makeSqlEventFetcher = (
  options: SelectionQueryOptions = {}
): Effect.Effect<EventFetcher<SqlError, never>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const fetchEvents = (selection: EventSelection, cursor: ProgressCursor, batchSize: number) =>
      Effect.gen(function* () {
        const query = buildEventSelectionQuery(selection, cursor, batchSize, options);
        const rows = yield* sql.unsafe<StoredEventRow>(query.sql, query.params);
        return rows.map(parseStoredEventRow);
      });

    const fetcher: EventFetcher<SqlError, never> = { fetchEvents };
    return fetcher;
  });

// Is there any committed event `selection` matches in `(after, upTo]`, in (transaction_id, position) order? Answers "has a
// consumer of this selection got everything up to `upTo`?" (nothing left for it to process there),
// which is not the same as its cursor having reached `upTo`: a cursor only ever lands on events the
// selection matched.
export const hasPendingSelectedEvents = (
  selection: EventSelection,
  after: ProgressCursor,
  upTo: ProgressCursor,
  options: SelectionQueryOptions = {}
): Effect.Effect<boolean, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = buildPendingSelectionQuery(selection, after, upTo, options);
    const rows = yield* sql.unsafe<{ pending: number }>(query.sql, query.params);
    return rows.length > 0;
  });
