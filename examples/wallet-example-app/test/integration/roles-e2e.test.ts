// Runs under Node (Testcontainers). ADR-0022, arrangement B: several instances of the wallet in ONE test process, each with its own connection pool and its own role,
// against one database. They share nothing but Postgres, so what works here works as separate deployments. Checks the main flows across roles and, from
// pg_locks and pg_stat_activity, what each role holds.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutorLive } from "@crablet/commands";
import { AUTOMATIONS_LOCK_KEY, VIEWS_LOCK_KEY } from "@crablet/eventstore/Leader";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startWalletAppForTest, type CoreServices, type RunningWalletApp } from "../support/startWalletAppForTest.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";
import { rolesFromEnv } from "../../src/roles.ts";

const TOKEN = "admin-token-for-tests";

let db: TestDb;
interface Instance { readonly name: string; readonly runtime: ManagedRuntime.ManagedRuntime<CoreServices, never>; readonly app: RunningWalletApp }
const instances = new Map<string, Instance>();

// One instance: its own pool (named in pg_stat_activity), its own role.
const startInstance = async (name: string, roles: string): Promise<Instance> => {
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password),
    applicationName: `wallet-${name}`
  });
  const coreLayers = Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive);
  const runtime = ManagedRuntime.make(Layer.provideMerge(coreLayers, pgLayer) as unknown as Layer.Layer<CoreServices, never>);
  const app = await startWalletAppForTest(runtime, undefined, TOKEN, { roles: rolesFromEnv(roles), instanceId: name });
  const instance = { name, runtime, app };
  instances.set(name, instance);
  return instance;
};

before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  await startInstance("api", "api");
  await startInstance("views-a", "views");
  await startInstance("views-b", "views");
  await startInstance("automations", "automations");
}, { timeout: 120_000 });

after(async () => {
  for (const { app, runtime } of instances.values()) { await app.stop(); await runtime.dispose(); }
  await db.stop();
});

const api = () => instances.get("api")!.app.baseUrl;
const post = (command: string, body: unknown) =>
  fetch(`${api()}/api/commands/${command}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const admin = (method: string, path: string) => fetch(`${api()}${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
const newWallet = () => `wallet-${crypto.randomUUID()}`;
const query = async <T>(text: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<T>> => {
  const client = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await client.connect();
  try { return (await client.query(text, params as unknown[])).rows as T[]; } finally { await client.end(); }
};
const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
interface Info { kind: string; id: string; status: string; cursorPosition: string | null; pendingEvents: number | null }
const processors = async (): Promise<ReadonlyArray<Info>> => ((await (await admin("GET", "/admin/processors")).json()) as { processors: Array<Info> }).processors;

// The advisory locks each instance holds: [application_name, key].
const locksHeld = async () =>
  query<{ app: string; key: string }>(
    `SELECT a.application_name AS app, ((l.classid::bigint << 32) | l.objid::bigint)::text AS key
       FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE l.locktype = 'advisory' AND l.granted AND a.application_name LIKE 'wallet-%'`
  );
const listeners = async (app: string) =>
  (await query<{ q: string }>("SELECT query AS q FROM pg_stat_activity WHERE application_name = $1 AND query ILIKE 'LISTEN%'", [`wallet-${app}`])).map((r) => r.q);

describe("roles across instances (ADR-0022, arrangement B)", () => {
  it("a command through the api instance is projected by a views instance and read back from the api instance with its marker", { timeout: 60_000 }, async () => {
    const walletId = newWallet();
    const opened = await post("open_wallet", { walletId, owner: "Ana", initialBalance: 10 });
    assert.strictEqual(opened.status, 201);
    const marker = ((await opened.json()) as { marker: string }).marker;
    const read = await fetch(`${api()}/api/wallets/${walletId}?consistentWith=${marker}`);
    assert.strictEqual(read.status, 200, "the read waited for a view that another instance builds");
    assert.strictEqual(((await read.json()) as { balance: number }).balance, 10);

    assert.strictEqual((await post("deposit", { depositId: crypto.randomUUID(), walletId, amount: 5, description: "tip" })).status, 201);
    const after = await fetch(`${api()}/api/wallets/${walletId}`);
    assert.strictEqual(((await after.json()) as { balance: number }).balance, 15, "consistent by default, across instances");
  });

  it("the automation fires on its own instance when the wallet is opened through the api instance", { timeout: 60_000 }, async () => {
    const walletId = newWallet();
    await post("open_wallet", { walletId, owner: "Bo", initialBalance: 0 });
    const events = await until(
      () => query<{ type: string }>("SELECT type FROM crablet_events WHERE type = 'WelcomeNotificationSent' AND tags @> ARRAY[$1::text]", [`wallet_id=${walletId}`]),
      (rows) => rows.length >= 1,
      "the welcome notification to be recorded by the automations instance"
    );
    assert.strictEqual(events.length, 1);
  });

  it("each role holds only its own locks and LISTENs: the api none of the leader locks, exactly one views instance leads, the automations instance has only its own", { timeout: 60_000 }, async () => {
    const held = await until(locksHeld, (rows) => rows.some((r) => r.key === VIEWS_LOCK_KEY.toString()) && rows.some((r) => r.key === AUTOMATIONS_LOCK_KEY.toString()), "the leaders to take their locks");
    assert.deepStrictEqual(held.filter((r) => r.app === "wallet-api"), [], "the api instance holds no leader lock");
    const viewsLocks = held.filter((r) => r.key === VIEWS_LOCK_KEY.toString());
    assert.strictEqual(viewsLocks.length, 1, "exactly one of the two views instances leads");
    assert.ok(viewsLocks[0]!.app === "wallet-views-a" || viewsLocks[0]!.app === "wallet-views-b");
    assert.deepStrictEqual(held.filter((r) => r.app === "wallet-automations").map((r) => r.key), [AUTOMATIONS_LOCK_KEY.toString()], "the automations instance holds the automations lock and no other");
    assert.ok(!held.some((r) => r.app.startsWith("wallet-views") && r.key === AUTOMATIONS_LOCK_KEY.toString()), "a views instance holds no automations lock");

    const eventsListen = (qs: ReadonlyArray<string>) => qs.filter((q) => /crablet_events/.test(q));
    assert.deepStrictEqual(eventsListen(await listeners("api")), [], "the api instance does not LISTEN for event wake-ups");
    assert.ok(eventsListen(await listeners("views-a")).length >= 1 && eventsListen(await listeners("views-b")).length >= 1, "a views instance LISTENs for wake-ups, on the follower too");
    assert.ok(eventsListen(await listeners("automations")).length >= 1);
  });

  it("the admin API on the api instance lists every module although it runs none, with the status read from the database", { timeout: 60_000 }, async () => {
    const all = await until(processors, (ps) => ps.length === 6 && ps.every((p) => p.cursorPosition !== null), "every processor to have a progress row");
    assert.deepStrictEqual(all.map((p) => p.kind).sort(), ["automations", "outbox", "views", "views", "views", "views"]);
    assert.ok(all.every((p) => p.status === "ACTIVE"));
  });

  it("pause and resume through the api instance act on the loop running in another instance", { timeout: 60_000 }, async () => {
    const walletId = newWallet();
    await post("open_wallet", { walletId, owner: "Cy", initialBalance: 1 });
    await until(() => query("SELECT 1 FROM wallet_balance_view WHERE wallet_id = $1", [walletId]), (r) => r.length === 1, "the view to have the wallet");

    const paused = await admin("POST", "/admin/processors/views/wallet-balance-view/pause");
    assert.deepStrictEqual(await paused.json(), { kind: "views", id: "wallet-balance-view", status: "PAUSED" });
    const other = newWallet();
    await post("open_wallet", { walletId: other, owner: "Di", initialBalance: 2 });
    await new Promise((r) => setTimeout(r, 3_000)); // three polling intervals of the views loop
    assert.deepStrictEqual(await query("SELECT 1 FROM wallet_balance_view WHERE wallet_id = $1", [other]), [], "the paused view did not move");

    await admin("POST", "/admin/processors/views/wallet-balance-view/resume");
    await until(() => query("SELECT 1 FROM wallet_balance_view WHERE wallet_id = $1", [other]), (r) => r.length === 1, "the resumed view to catch up");
  });

  it("when the leading views instance stops, the other takes over", { timeout: 90_000 }, async () => {
    const lockOwner = async () => (await locksHeld()).find((r) => r.key === VIEWS_LOCK_KEY.toString())?.app;
    const leader = (await lockOwner())!;
    const leaderInstance = instances.get(leader.replace("wallet-", ""))!;
    await leaderInstance.app.stop();
    const next = await until(lockOwner, (app) => app !== undefined && app !== leader, "the other views instance to take the lock");
    assert.notStrictEqual(next, leader);

    const walletId = newWallet();
    await post("open_wallet", { walletId, owner: "Ed", initialBalance: 3 });
    const read = await fetch(`${api()}/api/wallets/${walletId}`);
    assert.strictEqual(read.status, 200, "views keep being built after the failover");
  });
});
