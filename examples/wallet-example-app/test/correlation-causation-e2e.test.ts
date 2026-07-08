// Runs under Node (Testcontainers) - see NOTES.md. Confirms the correlation id supplied on the
// inbound HTTP request propagates through CommandApiLive's CorrelationContext.withCorrelationId
// into the WalletOpened event itself, AND that the automations processor's own
// AutomationEventHandler.ts propagates that same correlation id (plus a causationId equal to the
// triggering WalletOpened event's own position) onto the WelcomeNotificationSent event it issues -
// this is the one behavior that can only be observed by inspecting stored events directly, not
// through any read endpoint.
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
import { WALLET_OPENED } from "../src/domain/events/WalletEvents.ts";
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

const collectingProjector = (eventType: string) => ({
  eventTypes: [eventType],
  initialState: [] as ReadonlyArray<StoredEvent>,
  transition: (state: ReadonlyArray<StoredEvent>, event: StoredEvent) => [...state, event]
});

const eventsFor = (eventType: string, walletId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const eventStore = yield* EventStore;
      const result = yield* eventStore.project(
        Query.forEventAndTag(eventType, WalletTags.WALLET_ID, walletId),
        StreamPosition.zero(),
        [collectingProjector(eventType)]
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

describe("correlation/causation propagation E2E (HTTP -> event store -> automation-issued event)", () => {
  it("propagates the HTTP x-correlation-id onto WalletOpened, and the automation's WelcomeNotificationSent inherits it with causationId = WalletOpened's own position", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const correlationId = crypto.randomUUID();

    const res = await fetch(`${app.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-correlation-id": correlationId },
      body: JSON.stringify({ commandType: "open_wallet", command: { walletId, owner: "Karl", initialBalance: 0 } })
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.headers.get("x-correlation-id"), correlationId);

    const openedEvents = await waitUntilAsync(() => eventsFor(WALLET_OPENED, walletId), (e) => e.length >= 1);
    assert.strictEqual(openedEvents.length, 1);
    const walletOpened = openedEvents[0]!;
    assert.strictEqual(walletOpened.correlationId, correlationId);

    const notificationEvents = await waitUntilAsync(
      () => eventsFor(WELCOME_NOTIFICATION_SENT, walletId),
      (e) => e.length >= 1
    );
    assert.strictEqual(notificationEvents.length, 1);
    const welcomeNotificationSent = notificationEvents[0]!;
    assert.strictEqual(welcomeNotificationSent.correlationId, correlationId);
    assert.strictEqual(welcomeNotificationSent.causationId, walletOpened.position);
  });

  it("without an inbound correlation header, one is generated, echoed back, and stored on the event", async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    const res = await fetch(`${app.baseUrl}/api/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandType: "open_wallet", command: { walletId, owner: "Liam", initialBalance: 0 } })
    });
    assert.strictEqual(res.status, 201);
    const generatedCorrelationId = res.headers.get("x-correlation-id");
    assert.ok(generatedCorrelationId !== null);

    const openedEvents = await waitUntilAsync(() => eventsFor(WALLET_OPENED, walletId), (e) => e.length >= 1);
    assert.strictEqual(openedEvents[0]!.correlationId, generatedCorrelationId);
  });
});
