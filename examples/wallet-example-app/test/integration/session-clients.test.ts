// Runs under Node (Testcontainers) - see NOTES.md. Option B for a pooler in transaction mode: a module's leader lock and every LISTEN can sit on their OWN connection (`SessionClients`,
// `Crablet.layer(pg, { session })`), while the commands, the appends and the views' transactions use the application's. The two clients carry different application names, and the
// database says who holds what: the three leader locks and every LISTEN backend must belong to the session client, and the application's backends must hold none of them.
// A control without the session client shows the same query finding everything on the application's client, so the test can tell the difference.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { AUTOMATIONS_LOCK_KEY, OUTBOX_LOCK_KEY, VIEWS_LOCK_KEY } from "@crablet/eventstore/Leader";
import { sessionClientsLayer } from "@crablet/eventstore/SessionClients";
import { CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startWalletAppForTest, type CoreServices, type RunningWalletApp } from "../support/startWalletAppForTest.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";

let db: TestDb;
let probe: Client;
before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  probe = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password, application_name: "probe" });
  await probe.connect();
}, { timeout: 60_000 });
after(async () => {
  await probe.end();
  await db.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pgConfig = (applicationName: string) => ({
  host: db.connInfo.host,
  port: db.connInfo.port,
  database: db.connInfo.database,
  username: db.connInfo.username,
  password: Redacted.make(db.connInfo.password),
  applicationName
});

// Which application_name holds each leader lock, and which hold a LISTEN.
const whoHolds = async () => {
  const keys = [OUTBOX_LOCK_KEY, VIEWS_LOCK_KEY, AUTOMATIONS_LOCK_KEY];
  const locks = await probe.query<{ key: string; application_name: string }>(
    `SELECT (((l.classid::bigint << 32) | l.objid::bigint))::text AS key, a.application_name
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND (((l.classid::bigint << 32) | l.objid::bigint)) = ANY($1::bigint[])`,
    [keys.map(String)]
  );
  const listens = await probe.query<{ application_name: string }>(`SELECT application_name FROM pg_stat_activity WHERE query ILIKE 'LISTEN%' AND state = 'idle'`);
  return { lockHolders: locks.rows.map((r) => r.application_name), listeners: listens.rows.map((r) => r.application_name) };
};

const withApp = async (session: boolean, body: (app: RunningWalletApp) => Promise<void>) => {
  const appLayers = Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive, ...(session ? [sessionClientsLayer({ ...pgConfig("crablet-session"), maxConnections: 10 })] : []));
  const runtime = ManagedRuntime.make(Layer.provideMerge(appLayers, PgClient.layer({ ...pgConfig("crablet-main"), maxConnections: 10 })) as unknown as Layer.Layer<CoreServices, never>);
  const app = await startWalletAppForTest(runtime);
  try {
    // the three roles have taken their locks, and the LISTEN connections are up
    for (let i = 0; i < 100; i++) {
      const w = await whoHolds();
      if (w.lockHolders.length === 3 && w.listeners.length >= 4) break;
      await sleep(100);
    }
    await body(app);
  } finally {
    await app.stop();
    await runtime.dispose();
  }
};

describe("the leader locks and LISTEN on a session connection of their own (option B)", () => {
  it("with SessionClients: all three leader locks and every LISTEN belong to the session client; the application's backends hold none", { timeout: 60_000 }, async () => {
    await withApp(true, async (app) => {
      const w = await whoHolds();
      assert.deepStrictEqual(w.lockHolders, ["crablet-session", "crablet-session", "crablet-session"], "views, automations and outbox lead from the session client");
      // 3 modules' wake-ups and the views' progress hub: with @effect/sql-pg each LISTEN holds a pooled connection, so with the 3 leader locks the session client keeps 7 for good
      assert.strictEqual(w.listeners.length, 4, "four LISTENs: the three modules' wake-ups and the views' progress hub");
      assert.deepStrictEqual([...new Set(w.listeners)], ["crablet-session"], "every LISTEN, the pollers' wake-ups and the views' progress hub, is on the session client");

      // and the application still works on its own client: a command, then a consistent read of the view it feeds
      const post = await fetch(`${app.baseUrl}/api/commands/open_wallet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletId: "w-session", owner: "Ana", initialBalance: 7 }) });
      assert.strictEqual(post.status, 201);
      const read = await fetch(`${app.baseUrl}/api/wallets/w-session`);
      assert.strictEqual(read.status, 200);
      assert.strictEqual(((await read.json()) as { balance: number }).balance, 7);
    });
  });

  it("control, without it: the same query finds the leader locks and LISTEN on the application's client", { timeout: 60_000 }, async () => {
    await withApp(false, async () => {
      const w = await whoHolds();
      assert.deepStrictEqual(w.lockHolders, ["crablet-main", "crablet-main", "crablet-main"]);
      assert.strictEqual(w.listeners.length, 4);
      assert.deepStrictEqual([...new Set(w.listeners)], ["crablet-main"]);
    });
  });
});
