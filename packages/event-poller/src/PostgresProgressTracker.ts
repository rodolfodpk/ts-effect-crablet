import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { ProgressTableNotReady, type ProgressTracker } from "./ProgressTracker.ts";
import type { ProcessorStatus } from "./ProcessorStatus.ts";
import { assertSafeIdentifier } from "./internal/identifiers.ts";

// Single-key progress table shape (matches crablet_view_progress/crablet_automation_progress in
// V3__crablet_processing_schema.sql): `<idColumn> TEXT PRIMARY KEY, instance_id, status,
// last_position, last_updated_at, error_count, last_error, last_error_at`. Does NOT support the
// outbox module's composite-key (topic, publisher) + leader-lease-column shape - that's a Phase 3
// concern if/when ported.
export interface ProgressTableSpec {
  readonly tableName: string;
  readonly idColumn: string;
}

const isUndefinedTable = (cause: unknown): boolean =>
  (cause as { code?: string } | null | undefined)?.code === "42P01";

// Port of AbstractSingleKeyProgressTracker.java (JDBC base for single-VARCHAR-PK progress tables).
//
// PATTERN NOTE - "factory function returning a value object" vs. eventstore's `Context.Tag` +
// `Layer.effect` (see EventStore.ts's primer). Both resolve `SqlClient` once and return an object
// of pre-wired closures over it - the difference is *how callers get an instance*. `EventStore` is
// a process-wide ambient singleton: any code can `yield* EventStore` from anywhere, without being
// handed one explicitly, because exactly one `EventStoreLive` is registered for the whole app.
// `makePostgresProgressTracker(spec)` is deliberately NOT registered as a singleton service,
// because there can be many of them at once with different `spec`s (one per progress table an
// application cares about) - callers call this factory explicitly, once per table, and pass the
// resulting `ProgressTracker` value around like any other object (see EventProcessor.ts's
// `EventProcessorDeps.progressTracker` field). Reach for `Context.Tag`+`Layer` when there's
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
      Effect.catchAll(effect, (e): Effect.Effect<never, SqlError | ProgressTableNotReady> =>
        isUndefinedTable(e.cause) ? Effect.fail(new ProgressTableNotReady()) : Effect.fail(e)
      );

    const getStatus = (id: I): Effect.Effect<ProcessorStatus, SqlError> =>
      Effect.map(
        sql.unsafe<{ status: ProcessorStatus }>(`SELECT status FROM ${table} WHERE ${idCol} = $1`, [id]),
        (rows) => rows[0]?.status ?? "ACTIVE"
      );

    const getLastPosition = (id: I): Effect.Effect<bigint, SqlError | ProgressTableNotReady> =>
      mapTableNotReady(
        Effect.map(
          sql.unsafe<{ last_position: string }>(
            `SELECT last_position FROM ${table} WHERE ${idCol} = $1`,
            [id]
          ),
          (rows) => (rows[0] ? BigInt(rows[0].last_position) : 0n)
        )
      );

    const updateProgress = (id: I, position: bigint): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql.unsafe(
          `UPDATE ${table} SET last_position = $2, last_updated_at = now() WHERE ${idCol} = $1`,
          [id, position.toString()]
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
      getLastPosition,
      updateProgress,
      recordError,
      resetErrorCount,
      getStatus,
      setStatus,
      autoRegister
    };
    return tracker;
  });
