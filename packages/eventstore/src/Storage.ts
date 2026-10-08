import { Duration, Effect, Metric } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import * as StorageMetrics from "@crablet/metrics-otel/StorageMetrics";

// Storage visibility (docs/adr/0019-storage-visibility-and-the-tag-table.md): how much space each `crablet_*` table takes, split into heap, indexes and TOAST, with a
// row estimate, read from the catalog. Cheap (no table scan) and read-only. The numbers say where the bytes go; they do not decide anything.
//
//   const report = yield* storageReport();
//   console.log(formatStorageReport(report));
//   // or keep the gauges current, in a fiber the application forks:
//   yield* Effect.forkDetach(monitorStorage({ every: "5 minutes" }));

export interface TableStorage {
  readonly table: string;
  // the planner's estimate (as fresh as the last autovacuum or ANALYZE); the real count of the events table is available with `{ exact: true }`
  readonly rows: number;
  readonly totalBytes: number;
  readonly heapBytes: number;
  readonly indexBytes: number;
  readonly toastBytes: number;
}

export interface StorageReport {
  // every crablet_* table, largest first
  readonly tables: ReadonlyArray<TableStorage>;
  // events in the log (estimated, or counted with `exact`)
  readonly events: number;
  // (events + tag table) total bytes per event; null for an empty log
  readonly bytesPerEvent: number | null;
}

// reltuples is -1 for a table never vacuumed or analyzed; fall back to the statistics collector's live-tuple count
const TABLES_SQL = `
  SELECT c.relname AS "table",
         COALESCE(NULLIF(c.reltuples, -1), s.n_live_tup, 0)::bigint AS rows,
         pg_total_relation_size(c.oid) AS total_bytes,
         pg_relation_size(c.oid) AS heap_bytes,
         pg_indexes_size(c.oid) AS index_bytes,
         CASE WHEN c.reltoastrelid = 0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid) END AS toast_bytes
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND c.relname LIKE 'crablet\\_%'
  ORDER BY total_bytes DESC, c.relname`;

export const storageReport = (options: { readonly exact?: boolean } = {}): Effect.Effect<StorageReport, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ table: string; rows: string; total_bytes: string; heap_bytes: string; index_bytes: string; toast_bytes: string }>(TABLES_SQL);
    const tables: ReadonlyArray<TableStorage> = rows.map((r) => ({
      table: r.table,
      rows: Number(r.rows),
      totalBytes: Number(r.total_bytes),
      heapBytes: Number(r.heap_bytes),
      indexBytes: Number(r.index_bytes),
      toastBytes: Number(r.toast_bytes)
    }));
    const eventsTable = tables.find((t) => t.table === "crablet_events");
    const events = options.exact === true
      ? Number((yield* sql.unsafe<{ n: string }>("SELECT count(*) AS n FROM crablet_events"))[0]!.n)
      : (eventsTable?.rows ?? 0);
    const tagBytes = tables.find((t) => t.table === "crablet_event_tag_keys")?.totalBytes ?? 0;
    const bytesPerEvent = events > 0 && eventsTable !== undefined ? (eventsTable.totalBytes + tagBytes) / events : null;
    return { tables, events, bytesPerEvent };
  });

// Sets the gauges from a report.
export const recordStorage = (report: StorageReport): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const t of report.tables) {
      const parts: ReadonlyArray<readonly [string, number]> = [["total", t.totalBytes], ["heap", t.heapBytes], ["indexes", t.indexBytes], ["toast", t.toastBytes]];
      for (const [part, bytes] of parts) yield* Metric.update(Metric.withAttributes(StorageMetrics.tableBytes, { table: t.table, part }), bytes);
      yield* Metric.update(Metric.withAttributes(StorageMetrics.tableRows, { table: t.table }), t.rows);
    }
    if (report.bytesPerEvent !== null) yield* Metric.update(StorageMetrics.bytesPerEvent, report.bytesPerEvent);
  });

// Keeps the gauges current: reads the catalog every `every` (default 5 minutes) for as long as the fiber lives. A failed read is logged and tried again later;
// it never fails the fiber.
export const monitorStorage = (options: { readonly every?: Duration.Input } = {}): Effect.Effect<never, never, SqlClient.SqlClient> =>
  Effect.forever(
    storageReport().pipe(
      Effect.flatMap(recordStorage),
      Effect.catch((error) => Effect.logWarning(`storage report failed: ${String(error)}`)),
      Effect.andThen(Effect.sleep(Duration.fromInputUnsafe(options.every ?? "5 minutes")))
    )
  );

const mib = (bytes: number): string => `${(bytes / 1_048_576).toFixed(bytes >= 10 * 1_048_576 ? 0 : 1)} MiB`;

export const formatStorageReport = (report: StorageReport): string => {
  const width = Math.max(5, ...report.tables.map((t) => t.table.length));
  const lines = [`${"table".padEnd(width)}  ${"rows".padStart(12)}  ${"total".padStart(10)}  ${"heap".padStart(10)}  ${"indexes".padStart(10)}  ${"toast".padStart(10)}`];
  for (const t of report.tables) {
    lines.push(`${t.table.padEnd(width)}  ${String(t.rows).padStart(12)}  ${mib(t.totalBytes).padStart(10)}  ${mib(t.heapBytes).padStart(10)}  ${mib(t.indexBytes).padStart(10)}  ${mib(t.toastBytes).padStart(10)}`);
  }
  lines.push(report.bytesPerEvent === null ? "events: none" : `events: ${report.events}; ${report.bytesPerEvent.toFixed(0)} bytes per event (events table + tag table, with their indexes)`);
  return lines.join("\n");
};
