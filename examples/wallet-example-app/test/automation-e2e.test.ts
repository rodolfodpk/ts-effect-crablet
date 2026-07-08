// Runs under Node (Testcontainers) - see NOTES.md. Confirms WalletOpenedAutomation actually fires
// through the real running app (opening a wallet over real HTTP triggers the automations
// processor, which issues SendWelcomeNotificationCommand) - there's no dedicated read endpoint for
// WelcomeNotificationSent, so this reads it back via EventStore.project, the same query-building
// vocabulary the domain code itself uses (not a raw SQL query against crablet_events).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { EventStore, EventStoreLive, type StoredEvent } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import * as StreamPosition from "@crablet/eventstore/StreamPosition";
import * as Query from "@crablet/eventstore/Query";
import { CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startWalletAppForTest, type CoreServices, type RunningWalletApp } from "./support/startWalletAppForTest.ts";
import { applyAppMigrations } from "./support/applyAppMigrations.ts";
import { WELCOME_NOTIFICATION_SENT } from "../src/domain/notification/WelcomeNotificationSent.ts";
import * as WalletTags from "../src/domain/WalletTags.ts";

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

const collectingProjector = {
  eventTypes: [WELCOME_NOTIFICATION_SENT],
  initialState: [] as ReadonlyArray<StoredEvent>,
  transition: (state: ReadonlyArray<StoredEvent>, event: StoredEvent) => [...state, event]
};

const welcomeNotificationEventsFor = (walletId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const eventStore = yield* EventStore;
      const result = yield* eventStore.project(
        Query.forEventAndTag(WELCOME_NOTIFICATION_SENT, WalletTags.WALLET_ID, walletId),
        StreamPosition.zero(),
        [collectingProjector]
      );
      return result.state;
    })
  );

const waitUntilAsync = async <A>(check: () => Promise<A>, predicate: (a: A) => boolean, timeoutMs = 10_000) => {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe("wallet automation E2E (WalletOpenedAutomation, real Postgres + real HTTP)", () => {
  it("opening a wallet triggers exactly one welcome notification", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const res = await post("open_wallet", { walletId, owner: "Grace", initialBalance: 0 });
    assert.strictEqual(res.status, 201);

    const events = await waitUntilAsync(() => welcomeNotificationEventsFor(walletId), (e) => e.length >= 1);
    assert.strictEqual(events.length, 1);
    const data = events[0]!.data as { walletId: string; owner: string };
    assert.strictEqual(data.walletId, walletId);
    assert.strictEqual(data.owner, "Grace");
  });

  it("is not triggered again by unrelated activity on the same wallet (idempotent, fires once)", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    await post("open_wallet", { walletId, owner: "Heidi", initialBalance: 100 });
    await waitUntilAsync(() => welcomeNotificationEventsFor(walletId), (e) => e.length >= 1);

    const depositRes = await post("deposit", { depositId: crypto.randomUUID(), walletId, amount: 50, description: "top-up" });
    assert.strictEqual(depositRes.status, 201);

    await new Promise((resolve) => setTimeout(resolve, 500));
    const events = await welcomeNotificationEventsFor(walletId);
    assert.strictEqual(events.length, 1);
  });

  it("fires independently for two different wallets", async () => {
    const walletId1 = `wallet-${crypto.randomUUID()}`;
    const walletId2 = `wallet-${crypto.randomUUID()}`;
    await post("open_wallet", { walletId: walletId1, owner: "Ivan", initialBalance: 0 });
    await post("open_wallet", { walletId: walletId2, owner: "Judy", initialBalance: 0 });

    const events1 = await waitUntilAsync(() => welcomeNotificationEventsFor(walletId1), (e) => e.length >= 1);
    const events2 = await waitUntilAsync(() => welcomeNotificationEventsFor(walletId2), (e) => e.length >= 1);
    assert.strictEqual(events1.length, 1);
    assert.strictEqual(events2.length, 1);
    assert.notStrictEqual((events1[0]!.data as { walletId: string }).walletId, (events2[0]!.data as { walletId: string }).walletId);
  });
});
