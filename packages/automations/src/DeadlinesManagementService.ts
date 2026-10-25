import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { makeProcessorManagementService, type ProcessorManagementService } from "@crablet/event-poller/ProcessorManagementService";
import type { EventProcessorHandle } from "@crablet/event-poller";
import type { ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import * as ProgressCursor from "@crablet/event-poller/ProgressCursor";
import { dueBacklog, makeDeadlineProgressTracker } from "./internal/DeadlineStore.ts";

// The deadlines processor's management service: pause, resume and reset, as for any processor. Its backlog is what matters for deadlines: how many are
// due and not fired (`pendingEvents`), and how long ago the oldest fell due (`oldestPendingSeconds`), read from crablet_deadlines; the admin API and the
// consumer gauges (MonitorProcessors) show them as they show a view's lag. Its cursor never moves, so it has no lag in positions.
export const makeDeadlinesManagementService = (
  handle: EventProcessorHandle<ProcessorConfig<string>, string>
): Effect.Effect<ProcessorManagementService<string>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const progressTracker = yield* makeDeadlineProgressTracker();
    const base = makeProcessorManagementService<string>({
      progressTracker,
      getAllStatuses: handle.service.getAllStatuses,
      pauseProcessor: handle.service.pause,
      resumeProcessor: handle.service.resume,
      backoffSnapshot: handle.backoffSnapshot,
      allBackoffSnapshots: handle.allBackoffSnapshots,
      selectionOf: handle.selectionFor,
      details: Effect.map(
        sql.unsafe<{ readonly id: string; readonly error_count: number; readonly last_error: string | null }>(
          "SELECT processor_name AS id, error_count, last_error FROM crablet_deadline_progress",
          []
        ),
        (rows) => new Map(rows.map((r) => [r.id, { errorCount: r.error_count, lastError: r.last_error }] as const))
      ),
      sql
    });
    return {
      ...base,
      getLag: () => Effect.succeed(null),
      getBacklog: () =>
        Effect.map(dueBacklog(sql), ({ due, oldestSeconds }) => ({
          cursor: ProgressCursor.zero,
          pendingEvents: due,
          capped: false,
          oldestPendingSeconds: oldestSeconds
        }))
    };
  });
