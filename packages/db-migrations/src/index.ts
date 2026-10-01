import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This repo owns the schema. Migrations are applied in the order listed (V<n>__ names).
export const sqlDir = path.join(__dirname, "..", "sql");

export const migrationFiles = [
  "V1__crablet_eventstore_schema.sql",
  "V2__crablet_commands_schema.sql",
  "V3__crablet_processing_schema.sql",
  "V4__crablet_multi_item_append_conditions.sql",
  "V5__crablet_writer_side_locking.sql",
  "V6__crablet_append_returns_position.sql",
  "V7__crablet_append_condition_xid_cursor.sql"
] as const;

export function migrationFilePaths(): ReadonlyArray<string> {
  return migrationFiles.map((f) => path.join(sqlDir, f));
}
