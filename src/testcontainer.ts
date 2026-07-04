import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(__dirname, "..", "sql");

const MIGRATION_FILES = [
  "V1__crablet_eventstore_schema.sql",
  "V2__crablet_commands_schema.sql",
  "V3__crablet_processing_schema.sql"
] as const;

export interface ConnInfo {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

export interface TestDb {
  readonly container: StartedPostgreSqlContainer;
  readonly connInfo: ConnInfo;
  stop(): Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();

  const connInfo: ConnInfo = {
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    username: container.getUsername(),
    password: container.getPassword()
  };

  const client = new Client({
    host: connInfo.host,
    port: connInfo.port,
    database: connInfo.database,
    user: connInfo.username,
    password: connInfo.password
  });
  await client.connect();
  try {
    for (const file of MIGRATION_FILES) {
      const sqlText = readFileSync(path.join(SQL_DIR, file), "utf-8");
      await client.query(sqlText);
    }
  } finally {
    await client.end();
  }

  return {
    container,
    connInfo,
    stop: async () => {
      await container.stop();
    }
  };
}
