// Runs under Node (Testcontainers) - see NOTES.md. The wallet's reads are consistent by default (ADR-0015): a read made after a write sees
// it, with no polling and no `?waitFor`; a read can carry the write's marker; a client cannot ask for a looser read; and when a view cannot
// catch up the read is a 503, never a stale answer.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { EventStoreLive } from "@crablet/eventstore";
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
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  const coreLayers = Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive);
  runtime = ManagedRuntime.make(Layer.provideMerge(coreLayers, pgLayer) as unknown as Layer.Layer<CoreServices, never>);
  app = await startWalletAppForTest(runtime);
}, { timeout: 60_000 });

after(async () => {
  await app.stop();
  await runtime.dispose();
  await db.stop();
});

const post = async (commandType: string, command: unknown) => {
  const res = await fetch(`${app.baseUrl}/api/commands/${commandType}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const get = async (path: string) => {
  const res = await fetch(`${app.baseUrl}${path}`);
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> };
};
const newWallet = () => `wallet-${crypto.randomUUID()}`;

describe("the wallet's reads are consistent by default", () => {
  it("a read right after a write sees it: no polling, no ?waitFor - even the very first read of a new wallet", { timeout: 30_000 }, async () => {
    for (let round = 0; round < 8; round++) {
      const walletId = newWallet();
      assert.strictEqual((await post("open_wallet", { walletId, owner: "Ana", initialBalance: 10 })).status, 201);
      const opened = await get(`/api/wallets/${walletId}`);
      assert.strictEqual(opened.status, 200, "the view has the wallet, because the read waited for it");
      assert.strictEqual(opened.body["balance"], 10);

      assert.strictEqual((await post("deposit", { depositId: crypto.randomUUID(), walletId, amount: 5, description: "tip" })).status, 201);
      const afterDeposit = await get(`/api/wallets/${walletId}`);
      assert.strictEqual(afterDeposit.body["balance"], 15, "one read, already includes the deposit");
      assert.strictEqual(afterDeposit.headers.get("crablet-consistency"), null, "and it is not marked stale");
    }
  });

  it("every read endpoint waits for its own view: balance, transactions and summary all include the write", { timeout: 30_000 }, async () => {
    const walletId = newWallet();
    await post("open_wallet", { walletId, owner: "Bo", initialBalance: 0 });
    await post("deposit", { depositId: crypto.randomUUID(), walletId, amount: 40, description: "first" });
    const [balance, transactions, summary] = await Promise.all([
      get(`/api/wallets/${walletId}`),
      get(`/api/wallets/${walletId}/transactions`),
      get(`/api/wallets/${walletId}/summary`)
    ]);
    assert.strictEqual(balance.body["balance"], 40);
    assert.strictEqual(transactions.body["transactions"].length, 1);
    assert.strictEqual(summary.body["totalDeposits"], 40);
  });

  it("a command's marker can be sent with the read: it waits for exactly that write", { timeout: 30_000 }, async () => {
    const walletId = newWallet();
    await post("open_wallet", { walletId, owner: "Cy", initialBalance: 0 });
    const deposit = await post("deposit", { depositId: crypto.randomUUID(), walletId, amount: 7, description: "marked" });
    assert.match(deposit.body["marker"], /^\d+:\d+$/);
    const read = await get(`/api/wallets/${walletId}/transactions?consistentWith=${deposit.body["marker"]}`);
    assert.strictEqual(read.status, 200);
    assert.strictEqual(read.body["transactions"].length, 1);
  });

  it("an unknown wallet is still a 404, answered after the wait", async () => {
    const read = await get(`/api/wallets/${newWallet()}`);
    assert.strictEqual(read.status, 404);
    assert.strictEqual(read.body["title"], "Not Found");
  });
});

describe("what a client may and may not ask for", () => {
  it("cannot loosen a read (clientMayRelax is off): consistency=eventual and =bounded are 400s that say why", async () => {
    const walletId = newWallet();
    for (const mode of ["eventual", "bounded"]) {
      const read = await get(`/api/wallets/${walletId}?consistency=${mode}`);
      assert.strictEqual(read.status, 400, mode);
      assert.match(read.body["detail"], /not allowed/);
    }
    assert.strictEqual((await get(`/api/wallets/${walletId}?consistency=strict`)).status, 404, "strict is the default: allowed");
  });

  it("bad parameters are 400s with a problem body: a malformed marker, a marker beyond the log, a bad timeout, a bad limit", async () => {
    const walletId = newWallet();
    const bad = [
      `/api/wallets/${walletId}?consistentWith=nonsense`,
      `/api/wallets/${walletId}?consistentWith=99999999999999999:1`,
      `/api/wallets/${walletId}?waitTimeout=0`,
      `/api/wallets/${walletId}/transactions?limit=0`
    ];
    for (const path of bad) {
      const read = await get(path);
      assert.strictEqual(read.status, 400, path);
      assert.strictEqual(read.body["title"], "Bad Request", path);
    }
  });
});

describe("when a view cannot catch up", () => {
  it("a strict read is a 503 with Retry-After naming the view; once the poller can move again, the same read works", { timeout: 40_000 }, async () => {
    const holder = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
    await holder.connect();
    const walletId = newWallet();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_current_xact_id()"); // an open transaction holds back every poller
      await post("open_wallet", { walletId, owner: "Di", initialBalance: 3 });

      const refused = await get(`/api/wallets/${walletId}?waitTimeout=600`);
      assert.strictEqual(refused.status, 503);
      assert.strictEqual(refused.headers.get("retry-after"), "1");
      assert.strictEqual(refused.body["reason"], "lagging");
      assert.deepStrictEqual((refused.body["views"] as Array<{ name: string }>).map((v) => v.name), ["wallet-balance-view"]);

      await holder.query("COMMIT");
      const fresh = await get(`/api/wallets/${walletId}`);
      assert.strictEqual(fresh.status, 200);
      assert.strictEqual(fresh.body["balance"], 3);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });
});
