import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import {
  makeProcessorManagementService,
  type ProcessorManagementService
} from "@crablet/event-poller/ProcessorManagementService";
import type { EventProcessorHandle } from "@crablet/event-poller";
import type { ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import type { ProcessorStatus } from "@crablet/event-poller/ProcessorStatus";
import { makePostgresProgressTracker } from "@crablet/event-poller/PostgresProgressTracker";

// Port of com.crablet.views.service.ViewManagementService / ViewProgressDetails - wraps the generic
// ProcessorManagementService with one extra query against crablet_view_progress for ops visibility.
export interface ViewProgressDetails {
  readonly viewName: string;
  readonly status: ProcessorStatus;
  readonly instanceId: string | null;
  readonly lastPosition: bigint;
  readonly errorCount: number;
  readonly lastError: string | null;
  readonly lastUpdatedAt: Date | null;
}

export interface ViewManagementService extends ProcessorManagementService<string> {
  readonly getProgressDetails: (viewName: string) => Effect.Effect<ViewProgressDetails | null, SqlError>;
  readonly getAllProgressDetails: Effect.Effect<ReadonlyArray<ViewProgressDetails>, SqlError>;
}

interface ProgressRow {
  readonly view_name: string;
  readonly status: ProcessorStatus;
  readonly instance_id: string | null;
  readonly last_position: string;
  readonly error_count: number;
  readonly last_error: string | null;
  readonly last_updated_at: Date | null;
}

const toDetails = (row: ProgressRow): ViewProgressDetails => ({
  viewName: row.view_name,
  status: row.status,
  instanceId: row.instance_id,
  lastPosition: BigInt(row.last_position),
  errorCount: row.error_count,
  lastError: row.last_error,
  lastUpdatedAt: row.last_updated_at
});

export const makeViewManagementService = (
  handle: EventProcessorHandle<ProcessorConfig<string>, string>
): Effect.Effect<ViewManagementService, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const progressTracker = yield* makePostgresProgressTracker<string>({
      tableName: "crablet_view_progress",
      idColumn: "view_name"
    });

    const base = makeProcessorManagementService<string>({
      progressTracker,
      getAllStatuses: handle.service.getAllStatuses,
      pauseProcessor: handle.service.pause,
      resumeProcessor: handle.service.resume,
      backoffSnapshot: handle.backoffSnapshot,
      allBackoffSnapshots: handle.allBackoffSnapshots,
      sql
    });

    const getProgressDetails = (viewName: string): Effect.Effect<ViewProgressDetails | null, SqlError> =>
      Effect.map(
        sql.unsafe<ProgressRow>("SELECT * FROM crablet_view_progress WHERE view_name = $1", [viewName]),
        (rows) => (rows[0] ? toDetails(rows[0]) : null)
      );

    const getAllProgressDetails: Effect.Effect<ReadonlyArray<ViewProgressDetails>, SqlError> = Effect.map(
      sql.unsafe<ProgressRow>("SELECT * FROM crablet_view_progress", []),
      (rows) => rows.map(toDetails)
    );

    return { ...base, getProgressDetails, getAllProgressDetails };
  });
