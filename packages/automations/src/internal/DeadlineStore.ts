import { Clock, Effect } from "effect";
import type { EventStoreService } from "@crablet/eventstore";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import { DeadlineFired } from "@crablet/commands/Deadline";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { EventFetcher } from "@crablet/event-poller/EventFetcher";
import * as ProgressCursor from "@crablet/event-poller/ProgressCursor";
import type { ProgressTracker } from "@crablet/event-poller/ProgressTracker";
import { makePostgresProgressTracker } from "@crablet/event-poller/PostgresProgressTracker";
import { parseStoredEventRow, STORED_EVENT_COLUMNS, type StoredEventRow } from "@crablet/event-poller/SqlEventFetcher";
import type { RecordFiring } from "./DeadlineEventHandler.ts";

// The SQL side of the deadlines processor (ADR-0043): what is due, read by time from crablet_deadlines, and a progress tracker whose cursor never moves.

// "Now" is the application's clock, the one `decide` stamped the due times with (decision 8); a test clock fixes both.
const nowIso: Effect.Effect<string> = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

// The due deadlines, oldest due first: their `crablet.DeadlineScheduled` events. The selection and the cursor are ignored: time makes a deadline due,
// not its place in the log. One range scan of the due-time index and a join on the events' primary key.
export const makeDeadlineFetcher = (): Effect.Effect<EventFetcher<SqlError, never>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fetchEvents = (_selection: unknown, _cursor: unknown, batchSize: number) =>
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<StoredEventRow>(
          `SELECT ${STORED_EVENT_COLUMNS}
             FROM crablet_deadlines d JOIN crablet_events e ON e.position = d.deadline_position
            WHERE d.due_at <= $1::timestamptz
            ORDER BY d.due_at, d.deadline_position
            LIMIT $2`,
          [yield* nowIso, batchSize]
        );
        return rows.map(parseStoredEventRow);
      });
    return { fetchEvents };
  });

// How many deadlines are due and not fired, and how long ago the oldest fell due: the deadlines processor's backlog.
export const dueBacklog = (sql: SqlClient.SqlClient): Effect.Effect<{ readonly due: number; readonly oldestSeconds: number | null }, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<{ due: string; oldest_seconds: number | null }>(
      `SELECT count(*)::text AS due, extract(epoch FROM ($1::timestamptz - min(due_at)))::float8 AS oldest_seconds
         FROM crablet_deadlines WHERE due_at <= $1::timestamptz`,
      [yield* nowIso]
    );
    const due = Number(rows[0]?.due ?? 0);
    const oldest = rows[0]?.oldest_seconds;
    return { due, oldestSeconds: due === 0 || oldest === null || oldest === undefined ? null : Math.max(0, oldest) };
  });

// The deadlines processor's progress row keeps its status, error count and registration. Its cursor stays at zero: what is left to fire is the rows of
// crablet_deadlines, and a fired deadline's row is gone. No `advanceCursor`, so the engine takes its non-atomic path: the fence before the batch, and a
// `HandledPrefix` that keeps the deadlines fired before a failure fired.
export const makeDeadlineProgressTracker = (): Effect.Effect<ProgressTracker<string>, never, SqlClient.SqlClient> =>
  Effect.map(makePostgresProgressTracker<string>({ tableName: "crablet_deadline_progress", idColumn: "processor_name" }), (tracker) => ({
    getCursor: () => Effect.succeed(ProgressCursor.zero),
    peekCursor: () => Effect.succeed(ProgressCursor.zero),
    updateCursor: () => Effect.void,
    recordError: tracker.recordError,
    resetErrorCount: tracker.resetErrorCount,
    getStatus: tracker.getStatus,
    setStatus: tracker.setStatus,
    autoRegister: tracker.autoRegister
  }));

// Records that a deadline fired: its row is deleted and `crablet.DeadlineFired` appended, caused by it, in one transaction. The row goes first, as the
// guard: a processor that finds it already gone (a zombie leader and its successor fired the same deadline) records nothing, so a deadline has one
// `DeadlineFired`. The command runs in a transaction of its own before this one: its append must be that transaction's first write (ADR-0033), so the two cannot be one.
export const makeRecordFiring = (sql: SqlClient.SqlClient, eventStore: EventStoreService): RecordFiring => (deadline, outcome) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const deleted = yield* sql`DELETE FROM crablet_deadlines WHERE deadline_position = ${deadline.position.toString()}::bigint RETURNING 1 AS gone`;
      if (deleted.length === 0) return false;
      const fired = DeadlineFired({ deadlinePosition: deadline.position.toString(), outcome: outcome.outcome, reason: outcome.reason });
      const append = CorrelationContext.withCausationId(deadline.position)(eventStore.append([fired]));
      yield* deadline.correlationId === null ? append : CorrelationContext.withCorrelationId(deadline.correlationId)(append);
      return true;
    })
  );
