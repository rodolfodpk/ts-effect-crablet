import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This repo owns the schema. Migrations are applied in the order listed (V<n>__ names): one file per part of the schema, in its final shape (ADR-0047).
export const sqlDir = path.join(__dirname, "..", "sql");

export const migrationFiles = [
  "V1__crablet_events.sql",
  "V2__crablet_append.sql",
  "V3__crablet_command_audit.sql",
  "V4__crablet_processor_progress.sql",
  "V5__crablet_deadlines.sql",
  "V6__crablet_append_sees_the_read.sql",
  "V7__crablet_event_metadata.sql"
] as const;

export function migrationFilePaths(): ReadonlyArray<string> {
  return migrationFiles.map((f) => path.join(sqlDir, f));
}
