import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { migrationFiles as coreMigrationFiles, sqlDir as coreSqlDir } from "@crablet/db-migrations";
import { dbConnInfoFromEnv, type DbConnInfo } from "./db.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appMigrationDir = path.join(__dirname, "..", "db", "migration");

// This app's own tables (the views), applied after the framework's core schema.
export const appMigrationFiles: ReadonlyArray<string> = [];

// Applies the framework's core schema, then this app's own. Plain pg.Client, not Effect: deploy-time bootstrapping.
// Run it ONCE against a fresh database (the migrations are not idempotent):   node src/migrate.ts
export async function migrate(connInfo: DbConnInfo): Promise<void> {
  const client = new Client({
    host: connInfo.host,
    port: connInfo.port,
    database: connInfo.database,
    user: connInfo.username,
    password: connInfo.password
  });
  await client.connect();
  try {
    for (const file of coreMigrationFiles) await client.query(readFileSync(path.join(coreSqlDir, file), "utf-8"));
    for (const file of appMigrationFiles) await client.query(readFileSync(path.join(appMigrationDir, file), "utf-8"));
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate(dbConnInfoFromEnv());
  console.log("Migrations applied.");
}
