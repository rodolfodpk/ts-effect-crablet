// Runs under Node (Testcontainers). A live leader keeps its lock under load with a tight lease (ADR-0045): the server ends a lock session that has been
// idle longer than `serverIdleTimeout`, and the heartbeat is what keeps it from being idle. Here the timeout is 7 s, just over the leader's own loss
// detection with the default heartbeat (6 s), and the whole wallet runs under steady load for a minute: every module must keep the same leader session
// throughout, and nothing may fail.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutorLive } from "@crablet/commands";
import { AUTOMATIONS_LOCK_KEY, OUTBOX_LOCK_KEY, VIEWS_LOCK_KEY } from "@crablet/eventstore/Leader";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startWalletAppForTest, type CoreServices, type RunningWalletApp } from "../support/startWalletAppForTest.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";

const LOAD_MS = 60_000;
let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<CoreServices, never>;
let app: RunningWalletApp;
let probe: Client;

before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  const pg = PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
  runtime = ManagedRuntime.make(Layer.provideMerge(Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive), pg) as unknown as Layer.Layer<CoreServices, never>);
  app = await startWalletAppForTest(runtime, undefined, undefined, { leader: { serverIdleTimeout: "7 seconds" } });
  probe = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await probe.connect();
}, { timeout: 60_000 });
after(async () => {
  await probe.end();
  await app.stop();
  await runtime.dispose();
  await db.stop();
});

const KEYS = { views: VIEWS_LOCK_KEY, automations: AUTOMATIONS_LOCK_KEY, outbox: OUTBOX_LOCK_KEY };
const holders = async (): Promise<Record<string, number | undefined>> => {
  const rows = (await probe.query<{ key: string; pid: number }>(
    "SELECT ((classid::bigint << 32) | objid::bigint)::text AS key, pid FROM pg_locks WHERE locktype = 'advisory' AND granted"
  )).rows;
  return Object.fromEntries(Object.entries(KEYS).map(([m, k]) => [m, rows.find((r) => r.key === k.toString())?.pid]));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (command: string, body: unknown) =>
  fetch(`${app.baseUrl}/api/commands/${command}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("a live leader keeps a tight lease under load (ADR-0045)", () => {
  it(`every module keeps the same leader session through ${LOAD_MS / 1000} s of load, with a 7 s server idle timeout`, { timeout: LOAD_MS + 60_000 }, async () => {
    let first: Record<string, number | undefined> = {};
    for (let i = 0; i < 100 && Object.values(first = await holders()).some((p) => p === undefined); i++) await sleep(200);
    assert.ok(Object.values(first).every((p) => p !== undefined), `every module leads: ${JSON.stringify(first)}`);

    const wallets = Array.from({ length: 10 }, () => `wallet-${crypto.randomUUID()}`);
    for (const walletId of wallets) assert.strictEqual((await post("open_wallet", { walletId, owner: "Ana", initialBalance: 1_000 })).status, 201);
    const statuses = new Map<number, number>();
    let changes = 0;
    const end = Date.now() + LOAD_MS;
    const load = Array.from({ length: 6 }, async () => {
      while (Date.now() < end) {
        const walletId = wallets[Math.floor(Math.random() * wallets.length)]!;
        const res = await post("deposit", { depositId: crypto.randomUUID(), walletId, amount: 1, description: "load" });
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        await res.text();
      }
    });
    const watch = (async () => {
      while (Date.now() < end) {
        const now = await holders();
        for (const m of Object.keys(KEYS)) if (now[m] !== first[m]) changes++;
        await sleep(500);
      }
    })();
    await Promise.all([...load, watch]);

    console.log(`DIAG leader lease under load: ${JSON.stringify([...statuses])} in ${LOAD_MS / 1000} s; leader sessions ${JSON.stringify(first)}; changes seen: ${changes}`);
    assert.strictEqual(changes, 0, "no module changed its leader session");
    assert.deepStrictEqual(await holders(), first);
    assert.deepStrictEqual([...statuses.keys()], [201], "every deposit succeeded");
    assert.ok((statuses.get(201) ?? 0) > 500, "the load was real");
  });
});
