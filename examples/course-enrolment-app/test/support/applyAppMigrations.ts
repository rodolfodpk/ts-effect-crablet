import type { ConnInfo } from "@crablet/test-support";
import { migrateApp } from "@crablet/db-migrations/Migrate";
import { courseMigrations } from "../../src/migrate.ts";

// `startTestDb()` applies only the framework's core schema; this app's own tables (the views) go on top.
export const applyAppMigrations = (conn: ConnInfo): Promise<void> => migrateApp(conn, courseMigrations);
