import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { migrationFiles, sqlDir } from "@crablet/db-migrations";

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

// Testcontainers-node hangs indefinitely under Bun (see NOTES.md) - this must run under Node.
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
    for (const file of migrationFiles) {
      const sqlText = readFileSync(`${sqlDir}/${file}`, "utf-8");
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
