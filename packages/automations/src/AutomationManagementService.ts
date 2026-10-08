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
import { makePostgresProgressTracker } from "@crablet/event-poller/PostgresProgressTracker";

// Automation management and progress details - wraps the generic ProcessorManagementService with one extra query against
// crablet_automation_progress for ops visibility. Mirrors ViewManagementService.ts exactly (single
// key, same shape), just against a different table/column.
export interface AutomationProgressDetails {
  readonly automationName: string;
  readonly status: ProcessorStatus;
  readonly instanceId: string | null;
  readonly lastPosition: bigint;
  readonly errorCount: number;
  readonly lastError: string | null;
  readonly lastUpdatedAt: Date | null;
}

export interface AutomationManagementService extends ProcessorManagementService<string> {
  readonly getProgressDetails: (automationName: string) => Effect.Effect<AutomationProgressDetails | null, SqlError>;
  readonly getAllProgressDetails: Effect.Effect<ReadonlyArray<AutomationProgressDetails>, SqlError>;
}

interface ProgressRow {
  readonly automation_name: string;
  readonly status: ProcessorStatus;
  readonly instance_id: string | null;
  readonly last_position: string;
  readonly error_count: number;
  readonly last_error: string | null;
  readonly last_updated_at: Date | null;
}

const toDetails = (row: ProgressRow): AutomationProgressDetails => ({
  automationName: row.automation_name,
  status: row.status,
  instanceId: row.instance_id,
  lastPosition: BigInt(row.last_position),
  errorCount: row.error_count,
  lastError: row.last_error,
  lastUpdatedAt: row.last_updated_at
});

export const makeAutomationManagementService = (
  handle: EventProcessorHandle<ProcessorConfig<string>, string>
): Effect.Effect<AutomationManagementService, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const progressTracker = yield* makePostgresProgressTracker<string>({
      tableName: "crablet_automation_progress",
      idColumn: "automation_name"
    });

    const base = makeProcessorManagementService<string>({
      progressTracker,
      getAllStatuses: handle.service.getAllStatuses,
      pauseProcessor: handle.service.pause,
      resumeProcessor: handle.service.resume,
      backoffSnapshot: handle.backoffSnapshot,
      allBackoffSnapshots: handle.allBackoffSnapshots,
      selectionOf: handle.selectionFor,
      details: Effect.map(
        sql.unsafe<{ readonly id: string; readonly error_count: number; readonly last_error: string | null }>("SELECT automation_name AS id, error_count, last_error FROM crablet_automation_progress", []),
        (rows) => new Map(rows.map((r) => [r.id, { errorCount: r.error_count, lastError: r.last_error }] as const))
      ),
      sql
    });

    const getProgressDetails = (automationName: string): Effect.Effect<AutomationProgressDetails | null, SqlError> =>
      Effect.map(
        sql.unsafe<ProgressRow>("SELECT * FROM crablet_automation_progress WHERE automation_name = $1", [
          automationName
        ]),
        (rows) => (rows[0] ? toDetails(rows[0]) : null)
      );

    const getAllProgressDetails: Effect.Effect<ReadonlyArray<AutomationProgressDetails>, SqlError> = Effect.map(
      sql.unsafe<ProgressRow>("SELECT * FROM crablet_automation_progress", []),
      (rows) => rows.map(toDetails)
    );

    return { ...base, getProgressDetails, getAllProgressDetails };
  });
