// Runs under Node (Testcontainers) - see NOTES.md. Confirms appended events are actually forwarded
// through the outbox processor to a real OutboxPublisher - using a capturing test publisher
// (injected via startBackgroundProcessors' outboxPublishers parameter) instead of asserting on
// console log output, which makeLogPublisher() alone would force.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { EventStoreLive, type StoredEvent } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutorLive } from "@crablet/commands";
import type { OutboxPublisher } from "@crablet/outbox/OutboxPublisher";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startWalletAppForTest, type CoreServices, type RunningWalletApp } from "./support/startWalletAppForTest.ts";
import { applyAppMigrations } from "./support/applyAppMigrations.ts";
import { WALLET_OPENED, DEPOSIT_MADE } from "../src/domain/events/WalletEvents.ts";
import { WELCOME_NOTIFICATION_SENT } from "../src/domain/notification/WelcomeNotificationSent.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<CoreServices, never>;
let app: RunningWalletApp;
const captured: Array<StoredEvent> = [];

const capturingPublisher: OutboxPublisher<never> = {
  name: "CapturingTestPublisher",
  publishBatch: (events) =>
    Effect.sync(() => {
      captured.push(...events);
    })
};

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
  app = await startWalletAppForTest(runtime, [capturingPublisher]);
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

const waitUntilAsync = async <A>(check: () => A, predicate: (a: A) => boolean, timeoutMs = 10_000) => {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe("outbox forwarding E2E (real Postgres + real HTTP + capturing OutboxPublisher)", () => {
  it("forwards WalletOpened, the automation's WelcomeNotificationSent, and DepositMade for the same wallet", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const openRes = await post("open_wallet", { walletId, owner: "Mallory", initialBalance: 0 });
    assert.strictEqual(openRes.status, 201);

    const depositRes = await post("deposit", { depositId: crypto.randomUUID(), walletId, amount: 25, description: "gift" });
    assert.strictEqual(depositRes.status, 201);

    const forWallet = () => captured.filter((e) => e.tags.some((t) => t.value === walletId));
    const events = await waitUntilAsync(
      forWallet,
      (e) => e.some((ev) => ev.type === DEPOSIT_MADE) && e.some((ev) => ev.type === WELCOME_NOTIFICATION_SENT)
    );

    const types = events.map((e) => e.type);
    assert.ok(types.includes(WALLET_OPENED), `expected ${WALLET_OPENED} in ${JSON.stringify(types)}`);
    assert.ok(types.includes(WELCOME_NOTIFICATION_SENT), `expected ${WELCOME_NOTIFICATION_SENT} in ${JSON.stringify(types)}`);
    assert.ok(types.includes(DEPOSIT_MADE), `expected ${DEPOSIT_MADE} in ${JSON.stringify(types)}`);
  });
});
