// Runs under Node (Testcontainers). WALLET_WAKEUPS=off: appends send no notification and the processors do not LISTEN for one (no connection held for it), yet the views are built,
// by polling alone, and a read made after a write still sees it.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { makeEventStoreLayer } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startWalletAppForTest, type CoreServices, type RunningWalletApp } from "../support/startWalletAppForTest.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<CoreServices, never>;
let app: RunningWalletApp;
before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  const pgLayer = PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), applicationName: "wallet-off" });
  runtime = ManagedRuntime.make(Layer.provideMerge(Layer.mergeAll(CommandExecutorLive, makeEventStoreLayer({ wakeupMode: "off" }), CommandAuditStoreLive), pgLayer) as unknown as Layer.Layer<CoreServices, never>);
  app = await startWalletAppForTest(runtime, undefined, undefined, { polling: { pollingIntervalMs: 200, backoffMaxSeconds: 1, listenForWakeups: false } });
}, { timeout: 60_000 });
after(async () => { await app.stop(); await runtime.dispose(); await db.stop(); });

const query = async <T>(text: string): Promise<ReadonlyArray<T>> => {
  const client = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await client.connect();
  try { return (await client.query(text)).rows as T[]; } finally { await client.end(); }
};

describe("wake-ups off", () => {
  it("the processors hold no LISTEN for events, and the views are still built by polling", { timeout: 60_000 }, async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const res = await fetch(`${app.baseUrl}/api/commands/open_wallet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletId, owner: "Ana", initialBalance: 10 }) });
    assert.strictEqual(res.status, 201);
    const read = await fetch(`${app.baseUrl}/api/wallets/${walletId}`);
    assert.strictEqual(read.status, 200, "the read waited for the view, which polling built");
    assert.strictEqual(((await read.json()) as { balance: number }).balance, 10);
    const listens = await query<{ q: string }>("SELECT query AS q FROM pg_stat_activity WHERE application_name = 'wallet-off' AND query ILIKE 'LISTEN%'");
    assert.deepStrictEqual(listens.filter((r) => /crablet_events/.test(r.q)), [], "no LISTEN on the events channel");
  });
});
