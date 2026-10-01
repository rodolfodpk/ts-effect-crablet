import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import type { ConnInfo } from "@crablet/test-support";
import { appMigrationFiles } from "../../src/migrate.ts";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "migration");

// `startTestDb()` applies only the framework's core schema; this app's own tables (the view) go on top.
export async function applyAppMigrations(conn: ConnInfo): Promise<void> {
  const client = new Client({ host: conn.host, port: conn.port, database: conn.database, user: conn.username, password: conn.password });
  await client.connect();
  try {
    for (const file of appMigrationFiles) await client.query(readFileSync(path.join(dir, file), "utf-8"));
  } finally {
    await client.end();
  }
}
