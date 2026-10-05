import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { ProgressTableNotReady, type ProgressTracker } from "./ProgressTracker.ts";
import type { ProcessorStatus } from "./ProcessorStatus.ts";
import * as ProgressCursorNS from "./ProgressCursor.ts";
import type { ProgressCursor } from "./ProgressCursor.ts";
import { assertSafeIdentifier } from "./internal/identifiers.ts";

// Single-key progress table shape (matches crablet_view_progress/crablet_automation_progress in
// V3__crablet_processing_schema.sql): `<idColumn> TEXT PRIMARY KEY, instance_id, status,
// last_position, last_updated_at, error_count, last_error, last_error_at`. Does NOT support the
// outbox module's composite-key (topic, publisher) + leader-lease-column shape - that's a Phase 3
// concern if/when ported.
export interface ProgressTableSpec {
  readonly tableName: string;
  readonly idColumn: string;
  // Opt-in: when set, every `updateCursor` also sends a `pg_notify` on this channel, in the SAME statement as the update, so the ping is
  // delivered only once the new cursor has committed (a listener that reads the table after a ping sees it). The payload is JSON,
  // `{ "id": "<the processor id>", "transactionId": "<xid>", "position": "<position>" }` (see ProgressPing.ts). Views turn it on
  // (their feed pings clients); automations and the outbox do not. Best effort: a notification is not stored, so a listener must re-read
  // on reconnect rather than rely on having seen every ping.
  readonly notifyChannel?: string;
}

// The Postgres error (with its SQLSTATE `code`) is the `cause` of the SqlError's `reason`.
const isUndefinedTable = (error: SqlError): boolean =>
  (error.reason.cause as { code?: string } | null | undefined)?.code === "42P01";

// Progress tracker for single-VARCHAR-PK progress tables.
//
// PATTERN NOTE - "factory function returning a value object" vs. eventstore's `Context.Service` +
// `Layer.effect` (see EventStore.ts's primer). Both resolve `SqlClient` once and return an object
// of pre-wired closures over it - the difference is *how callers get an instance*. `EventStore` is
// a process-wide ambient singleton: any code can `yield* EventStore` from anywhere, without being
// handed one explicitly, because exactly one `EventStoreLive` is registered for the whole app.
// `makePostgresProgressTracker(spec)` is deliberately NOT registered as a singleton service,
// because there can be many of them at once with different `spec`s (one per progress table an
// application cares about) - callers call this factory explicitly, once per table, and pass the
// resulting `ProgressTracker` value around like any other object (see EventProcessor.ts's
// `EventProcessorDeps.progressTracker` field). Reach for `Context.Service`+`Layer` when there's
// exactly one logical instance for the whole program; reach for a plain factory function
// returning an `Effect` when a caller needs to construct several differently-configured instances
// of the same shape.
export const makePostgresProgressTracker = <I extends string>(
  spec: ProgressTableSpec
): Effect.Effect<ProgressTracker<I>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    assertSafeIdentifier(spec.tableName);
    assertSafeIdentifier(spec.idColumn);
    const sql = yield* SqlClient.SqlClient;
    const table = spec.tableName;
    const idCol = spec.idColumn;

    const mapTableNotReady = <A>(
      effect: Effect.Effect<A, SqlError>
    ): Effect.Effect<A, SqlError | ProgressTableNotReady> =>
      Effect.catch(effect, (e): Effect.Effect<never, SqlError | ProgressTableNotReady> =>
        isUndefinedTable(e) ? Effect.fail(new ProgressTableNotReady()) : Effect.fail(e)
      );

    const getStatus = (id: I): Effect.Effect<ProcessorStatus, SqlError> =>
      Effect.map(
        sql.unsafe<{ status: ProcessorStatus }>(`SELECT status FROM ${table} WHERE ${idCol} = $1`, [id]),
        (rows) => rows[0]?.status ?? "ACTIVE"
      );

    // transaction ids are xid8, which the Postgres client has no binary codec for: read as text, write with a cast.
    const getCursor = (id: I): Effect.Effect<ProgressCursor, SqlError | ProgressTableNotReady> =>
      mapTableNotReady(
        Effect.map(
          sql.unsafe<{ last_position: string; last_transaction_id: string }>(
            `SELECT last_position::text AS last_position, last_transaction_id::text AS last_transaction_id
             FROM ${table} WHERE ${idCol} = $1`,
            [id]
          ),
          (rows) =>
            rows[0]
              ? ProgressCursorNS.of(rows[0].last_transaction_id, BigInt(rows[0].last_position))
              : ProgressCursorNS.zero
        )
      );

    // Forward-only: the cursor never moves back. A processor that lost leadership without knowing it (a zombie) and writes late
    // changes nothing, and no ping is sent for an update that did not advance (docs/plans/reliability-and-scale-diagnostic.md, D2).
    const updateCursor = (id: I, cursor: ProgressCursor): Effect.Effect<void, SqlError> =>
      spec.notifyChannel === undefined
        ? Effect.asVoid(
            sql.unsafe(
              `UPDATE ${table} SET last_position = $2, last_transaction_id = $3::xid8, last_updated_at = now()
               WHERE ${idCol} = $1 AND (last_transaction_id, last_position) < ($3::xid8, $2::bigint)`,
              [id, cursor.position.toString(), cursor.transactionId]
            )
          )
        : // One statement: the update and the notify commit together, and no row means no notify.
          Effect.asVoid(
            sql.unsafe(
              `WITH updated AS (
                 UPDATE ${table} SET last_position = $2, last_transaction_id = $3::xid8, last_updated_at = now()
                 WHERE ${idCol} = $1 AND (last_transaction_id, last_position) < ($3::xid8, $2::bigint)
                 RETURNING ${idCol} AS id, last_transaction_id::text AS transaction_id, last_position::text AS position)
               SELECT pg_notify($4, json_build_object('id', id, 'transactionId', transaction_id, 'position', position)::text) FROM updated`,
              [id, cursor.position.toString(), cursor.transactionId, spec.notifyChannel]
            )
          );

    const recordError = (id: I, error: string, maxErrors: number): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql.unsafe(
          `UPDATE ${table}
           SET error_count = error_count + 1,
               last_error = $2,
               last_error_at = now(),
               status = CASE WHEN error_count + 1 >= $3 THEN 'FAILED' ELSE status END
           WHERE ${idCol} = $1`,
          [id, error, maxErrors]
        )
      );

    const resetErrorCount = (id: I): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql.unsafe(`UPDATE ${table} SET error_count = 0 WHERE ${idCol} = $1`, [id]));

    const setStatus = (id: I, status: ProcessorStatus): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql.unsafe(`UPDATE ${table} SET status = $2 WHERE ${idCol} = $1`, [id, status]));

    const autoRegister = (id: I, instanceId: string): Effect.Effect<void, ProgressTableNotReady | SqlError> =>
      mapTableNotReady(
        Effect.asVoid(
          sql.unsafe(
            `INSERT INTO ${table} (${idCol}, instance_id, status, last_position) VALUES ($1, $2, 'ACTIVE', 0)
             ON CONFLICT (${idCol}) DO NOTHING`,
            [id, instanceId]
          )
        )
      );

    const tracker: ProgressTracker<I> = {
      getCursor,
      updateCursor,
      recordError,
      resetErrorCount,
      getStatus,
      setStatus,
      autoRegister
    };
    return tracker;
  });
