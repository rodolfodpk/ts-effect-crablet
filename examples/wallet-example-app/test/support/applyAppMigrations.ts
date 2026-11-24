import type { ConnInfo } from "@crablet/test-support";
import { migrateApp } from "@crablet/db-migrations/Migrate";
import { walletMigrations } from "../../src/migrate.ts";

// `startTestDb()` (@crablet/test-support) applies the framework's schema; this app's own tables go on top.
export const applyAppMigrations = (connInfo: ConnInfo): Promise<void> => migrateApp(connInfo, walletMigrations);
