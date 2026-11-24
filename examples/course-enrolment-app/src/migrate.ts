import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, type AppMigrations } from "@crablet/db-migrations/Migrate";
import * as Crablet from "@crablet/app";
import { readCourseDatabase } from "./config.ts";

// This app's own tables (the views), applied after the framework's core schema.
export const appMigrationFiles: ReadonlyArray<string> = ["V100__course_seats_view.sql", "V101__course_seats_drop_last_position.sql", "V102__course_enrolments_view.sql", "V103__course_readiness_view.sql"];

// #region apply-migrations
// What `migrate` (@crablet/db-migrations/Migrate) applies after the framework's schema, in one transaction.
export const courseMigrations: AppMigrations = { dir: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migration"), files: appMigrationFiles };
// #endregion apply-migrations

// Run it ONCE against a fresh database (the migrations are not idempotent):   node src/migrate.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate(Crablet.plainConnection((await readCourseDatabase()).pg), courseMigrations);
  console.log("Migrations applied.");
}
