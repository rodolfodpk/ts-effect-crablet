import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, migrateIfFresh, type AppMigrations } from "@crablet/db-migrations/Migrate";

// The app's own migrations, in order. Every `V*.sql` in db/migration must be listed (test/migration-files.test.ts), because the lab's Flyway job applies the whole directory and this list is what the migrate job and the tests apply.
export const appMigrationFiles = [
  "V100__wallet_balance_view.sql",
  "V101__wallet_transaction_view.sql",
  "V102__wallet_summary_view.sql",
  "V103__wallet_statement_view.sql",
  "V104__wallet_transaction_view_page_index.sql",
  "V105__drop_statement_transactions.sql"
] as const;

// What `migrate` and `migrateIfFresh` (@crablet/db-migrations/Migrate) apply after the framework's schema.
export const walletMigrations: AppMigrations = { dir: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migration"), files: appMigrationFiles };

// `import.meta.main` is Bun/Deno-only - this app runs under Node (Testcontainers/pg driver
// see docs/history/NOTES.md), so the portable Node equivalent is comparing
// this module's own URL against the script Node was actually invoked with.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connInfo = {
    host: process.env["WALLET_DB_HOST"] ?? "localhost",
    port: Number(process.env["WALLET_DB_PORT"] ?? 5432),
    database: process.env["WALLET_DB_NAME"] ?? "wallet_db",
    username: process.env["WALLET_DB_USER"] ?? "postgres",
    password: process.env["WALLET_DB_PASSWORD"] ?? "postgres"
  };
  // As a pre-deploy job: `node src/migrate.ts` applies everything (run it once, on an empty database). WALLET_MIGRATE_MODE=if-fresh does what the entry point does at start-up
  // (several of these started together are the race the kind lab measures).
  if (process.env["WALLET_MIGRATE_MODE"] === "if-fresh") console.log(`migrations: ${await migrateIfFresh(connInfo, walletMigrations)}`);
  else {
    await migrate(connInfo, walletMigrations);
    console.log("Migrations applied.");
  }
}
