// Runs under Node (Testcontainers) - see NOTES.md. Exercises the ExposedCommand.mapError hooks +
// makeCommandApiGroup's extraErrors wiring end-to-end via real HTTP - not just unit-testing the
// mapping function in isolation, but confirming the RFC 7807 bodies actually round-trip through
// HttpApiBuilder's own encoding.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Layer, ManagedRuntime, Redacted } from "effect";
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

const post = (commandType: string, command: unknown) =>
  fetch(`${app.baseUrl}/api/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandType, command })
  });

describe("wallet error mapping E2E (RFC 7807 problem details over real HTTP)", () => {
  it("deposit to a nonexistent wallet -> 404 WalletNotFoundProblem", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const res = await post("deposit", { depositId: crypto.randomUUID(), walletId, amount: 10, description: "x" });
    assert.strictEqual(res.status, 404);
    const body = (await res.json()) as Record<string, unknown>;
    assert.strictEqual(body["type"], "urn:wallet-example-app:problem:wallet-not-found");
    assert.strictEqual(body["status"], 404);
    assert.ok(typeof body["detail"] === "string" && body["detail"].includes(walletId));
  });

  it("withdraw more than the balance -> 400 InsufficientFundsProblem with balance/requested detail", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const openRes = await post("open_wallet", { walletId, owner: "Bob", initialBalance: 20 });
    assert.strictEqual(openRes.status, 201);

    const res = await post("withdraw", { withdrawalId: crypto.randomUUID(), walletId, amount: 500, description: "too much" });
    assert.strictEqual(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.strictEqual(body["type"], "urn:wallet-example-app:problem:insufficient-funds");
    assert.strictEqual(body["status"], 400);
    assert.strictEqual(body["currentBalance"], 20);
    assert.strictEqual(body["requestedAmount"], 500);
  });

  it("opening the same wallet twice -> 409 conflict (Idempotent onDuplicate: THROW)", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const first = await post("open_wallet", { walletId, owner: "Eve", initialBalance: 0 });
    assert.strictEqual(first.status, 201);

    const second = await post("open_wallet", { walletId, owner: "Eve", initialBalance: 0 });
    assert.strictEqual(second.status, 409);
    const body = (await second.json()) as Record<string, unknown>;
    assert.strictEqual(body["violationCode"], "IDEMPOTENCY_VIOLATION");
  });

  it("transfer from a nonexistent wallet -> 404 WalletNotFoundProblem", async () => {
    const toWalletId = `wallet-${crypto.randomUUID()}`;
    await post("open_wallet", { walletId: toWalletId, owner: "Frank", initialBalance: 0 });

    const missingFromWalletId = `wallet-${crypto.randomUUID()}`;
    const res = await post("transfer_money", {
      transferId: crypto.randomUUID(),
      fromWalletId: missingFromWalletId,
      toWalletId,
      amount: 10,
      description: "x"
    });
    assert.strictEqual(res.status, 404);
    const body = (await res.json()) as Record<string, unknown>;
    assert.strictEqual(body["type"], "urn:wallet-example-app:problem:wallet-not-found");
    assert.ok(typeof body["detail"] === "string" && body["detail"].includes(missingFromWalletId));
  });
});
