import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import {
  makeProcessorManagementService,
  type ProcessorManagementService
} from "@crablet/event-poller/ProcessorManagementService";
import type { EventProcessorHandle } from "@crablet/event-poller";
import type { ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import type { ProcessorStatus } from "@crablet/event-poller/ProcessorStatus";
import { makeOutboxProgressTracker } from "./internal/OutboxProgressTracker.ts";
import * as TopicPublisherPair from "./TopicPublisherPair.ts";

// Outbox management and progress details - wraps the
// generic ProcessorManagementService with one extra query against crablet_outbox_topic_progress
// for ops visibility.
export interface OutboxProgressDetails {
  readonly topic: string;
  readonly publisher: string;
  readonly status: ProcessorStatus;
  readonly lastPosition: bigint;
  readonly lastPublishedAt: Date | null;
  readonly errorCount: number;
  readonly lastError: string | null;
  readonly updatedAt: Date;
  readonly leaderInstance: string | null;
  readonly leaderSince: Date | null;
  readonly leaderHeartbeat: Date | null;
}

export interface OutboxManagementService extends ProcessorManagementService<string> {
  readonly getProgressDetails: (
    topic: string,
    publisher: string
  ) => Effect.Effect<OutboxProgressDetails | null, SqlError>;
  readonly getAllProgressDetails: Effect.Effect<ReadonlyArray<OutboxProgressDetails>, SqlError>;
}

interface ProgressRow {
  readonly topic: string;
  readonly publisher: string;
  readonly status: ProcessorStatus;
  readonly last_position: string;
  readonly last_published_at: Date | null;
  readonly error_count: number;
  readonly last_error: string | null;
  readonly updated_at: Date;
  readonly leader_instance: string | null;
  readonly leader_since: Date | null;
  readonly leader_heartbeat: Date | null;
}

const toDetails = (row: ProgressRow): OutboxProgressDetails => ({
  topic: row.topic,
  publisher: row.publisher,
  status: row.status,
  lastPosition: BigInt(row.last_position),
  lastPublishedAt: row.last_published_at,
  errorCount: row.error_count,
  lastError: row.last_error,
  updatedAt: row.updated_at,
  leaderInstance: row.leader_instance,
  leaderSince: row.leader_since,
  leaderHeartbeat: row.leader_heartbeat
});

// `instanceId` here is for the management service's OWN progress-tracker instance (used only by
// pause/resume/reset), not the running processor's. The reads (getLag, getBacklog) use peekCursor, which does not
// refresh leader_instance/leader_heartbeat the way getCursor does (see internal/OutboxProgressTracker.ts), so
// monitoring never writes.
export const makeOutboxManagementService = (
  handle: EventProcessorHandle<ProcessorConfig<string>, string>,
  instanceId = "outbox-management-service"
): Effect.Effect<OutboxManagementService, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const progressTracker = yield* makeOutboxProgressTracker(instanceId);

    const base = makeProcessorManagementService<string>({
      progressTracker,
      getAllStatuses: handle.service.getAllStatuses,
      pauseProcessor: handle.service.pause,
      resumeProcessor: handle.service.resume,
      backoffSnapshot: handle.backoffSnapshot,
      allBackoffSnapshots: handle.allBackoffSnapshots,
      selectionOf: handle.selectionFor,
      details: Effect.map(
        sql.unsafe<{ readonly topic: string; readonly publisher: string; readonly error_count: number; readonly last_error: string | null }>(
          "SELECT topic, publisher, error_count, last_error FROM crablet_outbox_topic_progress",
          []
        ),
        (rows) => new Map(rows.map((r) => [TopicPublisherPair.toKey({ topic: r.topic, publisher: r.publisher }), { errorCount: r.error_count, lastError: r.last_error }] as const))
      ),
      sql
    });

    const getProgressDetails = (
      topic: string,
      publisher: string
    ): Effect.Effect<OutboxProgressDetails | null, SqlError> =>
      Effect.map(
        sql.unsafe<ProgressRow>(
          "SELECT * FROM crablet_outbox_topic_progress WHERE topic = $1 AND publisher = $2",
          [topic, publisher]
        ),
        (rows) => (rows[0] ? toDetails(rows[0]) : null)
      );

    const getAllProgressDetails: Effect.Effect<ReadonlyArray<OutboxProgressDetails>, SqlError> = Effect.map(
      sql.unsafe<ProgressRow>("SELECT * FROM crablet_outbox_topic_progress", []),
      (rows) => rows.map(toDetails)
    );

    return { ...base, getProgressDetails, getAllProgressDetails };
  });
