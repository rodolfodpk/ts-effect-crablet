import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { ProgressTableNotReady, type ProgressTracker } from "@crablet/event-poller/ProgressTracker";
import type { ProcessorStatus } from "@crablet/event-poller/ProcessorStatus";
import * as ProgressCursorNS from "@crablet/event-poller/ProgressCursor";
import type { ProgressCursor } from "@crablet/event-poller/ProgressCursor";
import { fromKey } from "../TopicPublisherPair.ts";

// The Postgres error (with its SQLSTATE `code`) is the `cause` of the SqlError's `reason`.
const isUndefinedTable = (error: SqlError): boolean =>
  (error.reason.cause as { code?: string } | null | undefined)?.code === "42P01";

// Hand-rolled against the composite
// (topic, publisher)-PK table `crablet_outbox_topic_progress`, since event-poller's
// makePostgresProgressTracker assumes a single VARCHAR PK column that doesn't fit this schema.
// `instanceId` is captured once at construction (like EventStoreLive captures `sql` once) because
// ProgressTracker<I>.getCursor's interface signature takes no instanceId argument, yet it
// still needs one to refresh leader_instance/leader_heartbeat on every call (see below).
export const makeOutboxProgressTracker = (
  instanceId: string
): Effect.Effect<ProgressTracker<string>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const mapTableNotReady = <A>(
      effect: Effect.Effect<A, SqlError>
    ): Effect.Effect<A, SqlError | ProgressTableNotReady> =>
      Effect.catch(effect, (e): Effect.Effect<never, SqlError | ProgressTableNotReady> =>
        isUndefinedTable(e) ? Effect.fail(new ProgressTableNotReady()) : Effect.fail(e)
      );

    const getStatus = (key: string): Effect.Effect<ProcessorStatus, SqlError> => {
      const { topic, publisher } = fromKey(key);
      return Effect.map(
        sql.unsafe<{ status: ProcessorStatus }>(
          "SELECT status FROM crablet_outbox_topic_progress WHERE topic = $1 AND publisher = $2",
          [topic, publisher]
        ),
        (rows) => rows[0]?.status ?? "ACTIVE"
      );
    };

    // Also refreshes leader_instance/leader_heartbeat on every call, not just on activity - this
    // runs every poll tick via EventProcessor.ts's process(), whether or not there's anything new
    // to fetch, so the heartbeat stays a real liveness signal during idle periods too, matching
    // what the migration's own column comment claims it means (no failover logic consumes it yet -
    // see the Phase 4 plan's heartbeat-design note).
    const getCursor = (key: string): Effect.Effect<ProgressCursor, SqlError | ProgressTableNotReady> => {
      const { topic, publisher } = fromKey(key);
      return mapTableNotReady(
        Effect.map(
          sql.unsafe<{ last_position: string; last_transaction_id: string }>(
            `UPDATE crablet_outbox_topic_progress
             SET leader_instance = $3, leader_heartbeat = now()
             WHERE topic = $1 AND publisher = $2
             RETURNING last_position::text AS last_position, last_transaction_id::text AS last_transaction_id`,
            [topic, publisher, instanceId]
          ),
          (rows) =>
            rows[0]
              ? ProgressCursorNS.of(rows[0].last_transaction_id, BigInt(rows[0].last_position))
              : ProgressCursorNS.zero
        )
      );
    };

    const updateCursor = (key: string, cursor: ProgressCursor): Effect.Effect<void, SqlError> => {
      const { topic, publisher } = fromKey(key);
      return Effect.asVoid(
        sql.unsafe(
          `UPDATE crablet_outbox_topic_progress
           SET last_position = $3, last_transaction_id = $5::xid8, last_published_at = now(), updated_at = now(),
               leader_instance = $4, leader_heartbeat = now()
           WHERE topic = $1 AND publisher = $2`,
          [topic, publisher, cursor.position.toString(), instanceId, cursor.transactionId]
        )
      );
    };

    // No last_error_at column on this table (unlike crablet_view_progress/crablet_automation_progress).
    const recordError = (key: string, error: string, maxErrors: number): Effect.Effect<void, SqlError> => {
      const { topic, publisher } = fromKey(key);
      return Effect.asVoid(
        sql.unsafe(
          `UPDATE crablet_outbox_topic_progress
           SET error_count = error_count + 1,
               last_error = $3,
               updated_at = now(),
               status = CASE WHEN error_count + 1 >= $4 THEN 'FAILED' ELSE status END
           WHERE topic = $1 AND publisher = $2`,
          [topic, publisher, error, maxErrors]
        )
      );
    };

    const resetErrorCount = (key: string): Effect.Effect<void, SqlError> => {
      const { topic, publisher } = fromKey(key);
      return Effect.asVoid(
        sql.unsafe(
          "UPDATE crablet_outbox_topic_progress SET error_count = 0 WHERE topic = $1 AND publisher = $2",
          [topic, publisher]
        )
      );
    };

    const setStatus = (key: string, status: ProcessorStatus): Effect.Effect<void, SqlError> => {
      const { topic, publisher } = fromKey(key);
      return Effect.asVoid(
        sql.unsafe(
          "UPDATE crablet_outbox_topic_progress SET status = $3 WHERE topic = $1 AND publisher = $2",
          [topic, publisher, status]
        )
      );
    };

    // No instance_id/created_at column here (unlike views/automations) - leader_instance/
    // leader_since play that role instead.
    const autoRegister = (key: string, id: string): Effect.Effect<void, ProgressTableNotReady | SqlError> => {
      const { topic, publisher } = fromKey(key);
      return mapTableNotReady(
        Effect.asVoid(
          sql.unsafe(
            `INSERT INTO crablet_outbox_topic_progress
               (topic, publisher, status, last_position, leader_instance, leader_since)
             VALUES ($1, $2, 'ACTIVE', 0, $3, now())
             ON CONFLICT (topic, publisher) DO NOTHING`,
            [topic, publisher, id]
          )
        )
      );
    };

    const tracker: ProgressTracker<string> = {
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
