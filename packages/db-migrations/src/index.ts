import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same .sql files as crablet-db-migrations in the Java repo, unmodified - kept byte-identical
// by convention, not by tooling. Ordered application matters (Flyway-style naming).
export const sqlDir = path.join(__dirname, "..", "sql");

export const migrationFiles = [
  "V1__crablet_eventstore_schema.sql",
  "V2__crablet_commands_schema.sql",
  "V3__crablet_processing_schema.sql"
] as const;

export function migrationFilePaths(): ReadonlyArray<string> {
  return migrationFiles.map((f) => path.join(sqlDir, f));
}
