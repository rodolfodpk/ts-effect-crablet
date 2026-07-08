import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import type { ConnInfo } from "@crablet/test-support";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.join(__dirname, "..", "..", "db", "migration");

const migrationFiles = [
  "V100__wallet_balance_view.sql",
  "V101__wallet_transaction_view.sql",
  "V102__wallet_summary_view.sql",
  "V103__wallet_statement_view.sql"
] as const;

// `startTestDb()` (@crablet/test-support) only applies @crablet/db-migrations' own core schema -
// this app's own view tables need a small local helper, run after `startTestDb()` returns, same
// plain-async-at-the-edges style `startTestDb` itself uses (this is test/deploy-time bootstrapping,
// not part of the system under test, so there's no Effect/SqlClient service to yield* yet). Not a
// change to @crablet/test-support - this app's migrations are its own concern, applied on top.
export async function applyAppMigrations(connInfo: ConnInfo): Promise<void> {
  const client = new Client({
    host: connInfo.host,
    port: connInfo.port,
    database: connInfo.database,
    user: connInfo.username,
    password: connInfo.password
  });
  await client.connect();
  try {
    for (const file of migrationFiles) {
      const sqlText = readFileSync(path.join(migrationDir, file), "utf-8");
      await client.query(sqlText);
    }
  } finally {
    await client.end();
  }
}
