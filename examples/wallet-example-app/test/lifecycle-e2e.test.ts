// Runs under Node (Testcontainers) - see NOTES.md. Full E2E happy path through the real running
// app (background processors + HTTP server), mirroring Java's WalletLifecycleE2ETest.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startWalletAppForTest, type CoreServices, type RunningWalletApp } from "./support/startWalletAppForTest.ts";
import { applyAppMigrations } from "./support/applyAppMigrations.ts";

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
  const layer = Layer.provideMerge(coreLayers, pgLayer) as unknown as Layer.Layer<CoreServices, never>;
  runtime = ManagedRuntime.make(layer);
  app = await startWalletAppForTest(runtime);
}, { timeout: 60_000 });

after(async () => {
  await app.stop();
  await runtime.dispose();
  await db.stop();
});

const waitUntilAsync = async <A>(check: () => Promise<A>, predicate: (a: A) => boolean, timeoutMs = 10_000) => {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const post = (commandType: string, command: unknown) =>
  fetch(`${app.baseUrl}/api/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandType, command })
  });

const getJson = (path: string) => fetch(`${app.baseUrl}${path}`).then((res) => res.json() as Promise<Record<string, unknown>>);

describe("wallet lifecycle E2E (real Postgres + real HTTP server)", () => {
  it("open -> deposit -> withdraw -> query balance/transactions/summary", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;

    const openRes = await post("open_wallet", { walletId, owner: "Alice", initialBalance: 0 });
    assert.strictEqual(openRes.status, 201);

    const balanceAfterOpen = await waitUntilAsync(
      () => getJson(`/api/wallets/${walletId}`),
      (body) => typeof body["balance"] === "number"
    );
    assert.strictEqual(balanceAfterOpen["balance"], 0);

    const depositRes = await post("deposit", { depositId: crypto.randomUUID(), walletId, amount: 100, description: "paycheck" });
    assert.strictEqual(depositRes.status, 201);

    await waitUntilAsync(() => getJson(`/api/wallets/${walletId}`), (body) => body["balance"] === 100);

    const withdrawRes = await post("withdraw", { withdrawalId: crypto.randomUUID(), walletId, amount: 30, description: "groceries" });
    assert.strictEqual(withdrawRes.status, 201);

    const finalBalance = await waitUntilAsync(() => getJson(`/api/wallets/${walletId}`), (body) => body["balance"] === 70);
    assert.strictEqual(finalBalance["balance"], 70);

    const transactions = await waitUntilAsync(
      () => getJson(`/api/wallets/${walletId}/transactions`),
      (body) => Array.isArray(body["transactions"]) && (body["transactions"] as Array<unknown>).length >= 2
    );
    assert.strictEqual((transactions["transactions"] as Array<unknown>).length, 2);

    const summary = await waitUntilAsync(
      () => getJson(`/api/wallets/${walletId}/summary`),
      (body) => body["totalDeposits"] === 100 && body["totalWithdrawals"] === 30
    );
    assert.strictEqual(summary["totalDeposits"], 100);
    assert.strictEqual(summary["totalWithdrawals"], 30);
    assert.strictEqual(summary["currentBalance"], 70);
  });

  it("transfer moves funds between two wallets, reflected in both balances", async () => {
    const fromWalletId = `wallet-${crypto.randomUUID()}`;
    const toWalletId = `wallet-${crypto.randomUUID()}`;
    await post("open_wallet", { walletId: fromWalletId, owner: "Carol", initialBalance: 200 });
    await post("open_wallet", { walletId: toWalletId, owner: "Dave", initialBalance: 0 });

    await waitUntilAsync(() => getJson(`/api/wallets/${fromWalletId}`), (body) => body["balance"] === 200);
    await waitUntilAsync(() => getJson(`/api/wallets/${toWalletId}`), (body) => body["balance"] === 0);

    const transferRes = await post("transfer_money", {
      transferId: crypto.randomUUID(),
      fromWalletId,
      toWalletId,
      amount: 75,
      description: "rent split"
    });
    assert.strictEqual(transferRes.status, 201);

    await waitUntilAsync(() => getJson(`/api/wallets/${fromWalletId}`), (body) => body["balance"] === 125);
    await waitUntilAsync(() => getJson(`/api/wallets/${toWalletId}`), (body) => body["balance"] === 75);
  });
});
