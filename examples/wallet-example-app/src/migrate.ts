import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { migrationFiles as coreMigrationFiles, sqlDir as coreSqlDir } from "@crablet/db-migrations";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appMigrationDir = path.join(__dirname, "..", "db", "migration");

const appMigrationFiles = [
  "V100__wallet_balance_view.sql",
  "V101__wallet_transaction_view.sql",
  "V102__wallet_summary_view.sql",
  "V103__wallet_statement_view.sql"
] as const;

export interface MigrateConnInfo {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

// Standalone script (plain pg.Client, not Effect) - this is deploy-time bootstrapping, before any
// SqlClient/Layer exists, same reasoning @crablet/test-support's startTestDb documents for why it
// isn't wrapped in Effect either. Applies core crablet migrations first, then this app's own -
// mirrors Java's `spring.flyway.locations=classpath:db/migration,classpath:db/migration/app`
// (two locations, core first).
export async function migrate(connInfo: MigrateConnInfo): Promise<void> {
  const client = new Client({
    host: connInfo.host,
    port: connInfo.port,
    database: connInfo.database,
    user: connInfo.username,
    password: connInfo.password
  });
  await client.connect();
  try {
    for (const file of coreMigrationFiles) {
      await client.query(readFileSync(path.join(coreSqlDir, file), "utf-8"));
    }
    for (const file of appMigrationFiles) {
      await client.query(readFileSync(path.join(appMigrationDir, file), "utf-8"));
    }
  } finally {
    await client.end();
  }
}

// `import.meta.main` is Bun/Deno-only - this app runs under Node (Testcontainers/pg driver
// parity with the rest of this port, see NOTES.md), so the portable Node equivalent is comparing
// this module's own URL against the script Node was actually invoked with.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate({
    host: process.env["WALLET_DB_HOST"] ?? "localhost",
    port: Number(process.env["WALLET_DB_PORT"] ?? 5432),
    database: process.env["WALLET_DB_NAME"] ?? "wallet_db",
    username: process.env["WALLET_DB_USER"] ?? "postgres",
    password: process.env["WALLET_DB_PASSWORD"] ?? "postgres"
  });
  console.log("Migrations applied.");
}
