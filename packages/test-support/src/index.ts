import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { mkdir, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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

// Testcontainers waits a hard-coded 10 s for a container's ports to be bound. `node --test` runs
// every test file in its own process, and dozens of containers starting at the same instant
// regularly blew that budget on a busy Docker VM. So container STARTS are serialized across
// processes with a mkdir-based lock (mkdir is atomic); the tests themselves still run in parallel,
// each against its own container. (A single shared server does not work: the poller only sees
// events from finished transactions, judged by a cluster-wide snapshot, so open transactions in
// other databases on the same server would hide events from unrelated test files.)
const START_LOCK = `${tmpdir()}/crablet-test-container-start.lock`;
const START_LOCK_STALE_MS = 60_000;
const START_LOCK_TIMEOUT_MS = 180_000;

async function withContainerStartLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + START_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(START_LOCK);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        // owner crashed without releasing?
        if (Date.now() - (await stat(START_LOCK)).mtimeMs > START_LOCK_STALE_MS) await rmdir(START_LOCK);
      } catch {
        // lock vanished between calls - just retry
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${START_LOCK}`);
      await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(START_LOCK).catch(() => {});
  }
}

// Even one start can exceed the fixed 10 s port-bind wait while other test containers are busy;
// that specific failure is transient, so retry it. (A failed attempt's container is cleaned up by
// Testcontainers' reaper when the process exits.) Any other error is not retried.
async function startContainerWithRetry(attempts = 3): Promise<StartedPostgreSqlContainer> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await new PostgreSqlContainer("postgres:17-alpine").start();
    } catch (e) {
      const transient = e instanceof Error && e.message.includes("waiting for container ports to be bound");
      if (!transient || attempt >= attempts) throw e;
    }
  }
}

// PATTERN NOTE: this function is plain `async`/`await` and raw `pg.Client`, not `Effect`/
// `SqlClient` - deliberately. It runs *before* any test's Effect `Layer` exists yet (spinning up
// the container and applying migrations is bootstrapping, not part of the system under test), so
// there's no ambient `SqlClient` service to `yield*` and no meaningful typed-error/dependency
// story to gain from wrapping it. Compare to eventstore's NotifyPayload.ts: reach for plain
// async/await at the edges of a program (test setup, CLI entry points) where Effect's extra
// structure isn't buying you anything; reach for `Effect` once you're inside the system that
// actually composes with the rest of this Effect-based codebase.
//
// Testcontainers-node hangs indefinitely under Bun (see NOTES.md) - this must run under Node.
export async function startTestDb(): Promise<TestDb> {
  const container = await withContainerStartLock(startContainerWithRetry);

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
