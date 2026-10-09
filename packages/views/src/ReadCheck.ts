import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import * as ProgressCursorNS from "@crablet/event-poller/ProgressCursor";
import type { ProgressCursor } from "@crablet/event-poller/ProgressCursor";
import { buildReadCheckQuery, type SelectionQueryOptions } from "@crablet/event-poller/SqlEventFetcher";
import type { ViewSubscription } from "./ViewSubscription.ts";

// The first look of a consistent read, in ONE statement instead of three that wait for one another: where the log ends, and for each view where it is and whether anything it
// handles is pending between its cursor and the write (`marker`, or the end of the log when null). Only the framework's own tables are read; the application's query is the
// caller's, separate. What to do about each view is `viewVerdict`, the same rule `waitUntilProcessed` ends in.
//
// One entry per subscription, in the order given (the same view twice gives two entries). A view with no progress row has the zero cursor and a null status.
export interface ReadCheckView {
  readonly cursor: ProgressCursor;
  readonly status: string | null;
  readonly pending: boolean;
}

export interface ReadCheckResult {
  readonly head: ProgressCursor;
  readonly views: ReadonlyArray<ReadCheckView>;
}

interface Row {
  readonly ord?: number | string;
  readonly head_xid: string | null;
  readonly head_pos: string | null;
  readonly cur_xid?: string | null;
  readonly cur_pos?: string | null;
  readonly status?: string | null;
  readonly pending?: boolean;
}

const headOf = (row: Row | undefined): ProgressCursor =>
  row === undefined || row.head_xid === null || row.head_pos === null ? ProgressCursorNS.zero : ProgressCursorNS.of(row.head_xid, BigInt(row.head_pos));

export const readCheck = (
  subscriptions: ReadonlyArray<ViewSubscription>,
  marker: ProgressCursor | null,
  options: SelectionQueryOptions = {}
): Effect.Effect<ReadCheckResult, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = buildReadCheckQuery(subscriptions, marker, options);
    const rows = yield* sql.unsafe<Row>(query.sql, query.params);
    const ordered = [...rows].sort((a, b) => Number(a.ord ?? 0) - Number(b.ord ?? 0));
    return {
      head: headOf(ordered[0]),
      views: ordered.map((row) => ({
        cursor: row.cur_xid == null || row.cur_pos == null ? ProgressCursorNS.zero : ProgressCursorNS.of(row.cur_xid, BigInt(row.cur_pos)),
        status: row.status ?? null,
        pending: row.pending === true
      }))
    };
  });
