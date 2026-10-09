// DIAGNOSTIC EXPERIMENT (docs/guides/run-in-production.md, "Polling and wake-ups"), not a test: it measures, it does not assert. Real Postgres (Testcontainers, needs Docker).
// Run with:  node --test examples/wallet-example-app/diagnostics/polling-load.diagnostic.ts   and read the `DIAG` lines.
//   QUICK=1 shortens every run (smoke test).   ONLY="bounded|idle" runs one profile/load pair.
// The whole wallet (api, views, automations, outbox: six processors) on one database, under three polling profiles and three loads, with pg_stat_statements counting what reaches the database.
//   - statements/s and db ms/s: every statement the database ran, minus the experiment's own monitoring. Under load this includes the commands themselves; the idle rows are the pure cost of polling.
//   - latency: from a command's response until its row is visible in wallet_balance_view (read by SQL, every 5 ms), p50 / p95. With wake-ups it is what the user sees; with "polling only"
//     (`wakeupMode: "off"`) it is the latency of a deployment that chose no notifications, and the worst case when they are lost: what the interval and the idle backoff bound.
import { after, before, describe, it } from "node:test";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { makeEventStoreLayer } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startWalletAppForTest, type CoreServices } from "../test/support/startWalletAppForTest.ts";
import { applyAppMigrations } from "../test/support/applyAppMigrations.ts";
import type { Polling } from "../src/polling.ts";

const QUICK = process.env["QUICK"] !== undefined;
const profiles: Record<string, Polling> = {
  quiet: { pollingIntervalMs: 1000, backoffMaxSeconds: 120 }, // the wallet's default before 2026-10-08
  bounded: { pollingIntervalMs: 1000, backoffMaxSeconds: 10 }, // the default now
  relaxed: { pollingIntervalMs: 5000, backoffMaxSeconds: 60 }
};
// commands per second; idle has none
const loads: Record<string, number> = { idle: 0, light: 2, moderate: 20 };

let db: TestDb;
let monitor: Client;
before(async () => {
  db = await startTestDb({ postgresArgs: ["-c", "shared_preload_libraries=pg_stat_statements"] });
  await applyAppMigrations(db.connInfo);
  monitor = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password, application_name: "experiment-monitor" });
  await monitor.connect();
  await monitor.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
}, { timeout: 120_000 });
after(async () => { await monitor.end(); await db.stop(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => (xs.length === 0 ? NaN : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!);

const run = async (profileName: string, loadName: string, wakeups: boolean) => {
  const polling = profiles[profileName]!;
  const rate = loads[loadName]!;
  const pgLayer = PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), applicationName: "wallet" });
  const eventStore = makeEventStoreLayer(wakeups ? {} : { wakeupMode: "off" });
  const runtime = ManagedRuntime.make(Layer.provideMerge(Layer.mergeAll(CommandExecutorLive, eventStore, CommandAuditStoreLive), pgLayer) as unknown as Layer.Layer<CoreServices, never>);
  const app = await startWalletAppForTest(runtime, undefined, undefined, { polling });
  const post = (walletId: string) =>
    fetch(`${app.baseUrl}/api/commands/open_wallet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletId, owner: "x", initialBalance: 1 }) });
  const latencies: number[] = [];
  let commands = 0;
  const one = async (record: boolean) => {
    const walletId = `w-${crypto.randomUUID()}`;
    await post(walletId);
    const t0 = performance.now();
    for (;;) {
      if ((await monitor.query("SELECT 1 FROM wallet_balance_view WHERE wallet_id = $1", [walletId])).rowCount === 1) break;
      if (performance.now() - t0 > 130_000) break;
      await sleep(5);
    }
    if (record) { latencies.push(performance.now() - t0); commands++; }
  };
  await one(false); // the first command, so the processors have a progress row
  const warm = QUICK ? 5 : rate === 0 ? 90 : 15;
  const measure = QUICK ? 10 : rate === 0 ? 60 : 40;
  const drive = async (seconds: number, record: boolean) => {
    const end = Date.now() + seconds * 1000;
    const tasks: Promise<void>[] = [];
    while (Date.now() < end) {
      if (rate > 0) tasks.push(one(record));
      await sleep(rate > 0 ? 1000 / rate : 1000);
    }
    await Promise.all(tasks);
  };
  await drive(warm, false);
  await monitor.query("SELECT pg_stat_statements_reset()");
  const t0 = Date.now();
  await drive(measure, true);
  const seconds = (Date.now() - t0) / 1000;
  const stats = (await monitor.query(
    `SELECT coalesce(sum(calls),0)::float AS calls, coalesce(sum(total_exec_time),0)::float AS ms
       FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%' AND query NOT ILIKE '%wallet_balance_view WHERE wallet_id%'`
  )).rows[0] as { calls: number; ms: number };
  if (process.env["DUMP"] !== undefined) {
    for (const r of (await monitor.query("SELECT calls, round(total_exec_time::numeric,1) AS ms, left(regexp_replace(query, '\\s+', ' ', 'g'), 110) AS q FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%' ORDER BY calls DESC LIMIT 12")).rows) console.log(`DUMP ${r.calls} ${r.ms}ms ${r.q}`);
  }
  console.log(
    `DIAG ${profileName.padEnd(8)} ${loadName.padEnd(9)} ${wakeups ? "wake-ups   " : "polling only"} | ${(stats.calls / seconds).toFixed(1).padStart(6)} statements/s | ${(stats.ms / seconds).toFixed(1).padStart(6)} db ms/s | ` +
    (rate === 0 ? "no commands" : `${(commands / seconds).toFixed(1)} cmd/s, latency p50 ${pct(latencies, 50).toFixed(0)} ms, p95 ${pct(latencies, 95).toFixed(0)} ms`)
  );
  await app.stop();
  await runtime.dispose();
};

describe("polling load by profile", () => {
  const only = process.env["ONLY"];
  it("profiles x loads, then the polling-only worst case", { timeout: 3_600_000 }, async () => {
    for (const load of ["idle", "light", "moderate"]) {
      for (const profile of Object.keys(profiles)) {
        if (only !== undefined && only !== `${profile}|${load}`) continue;
        await run(profile, load, true);
      }
    }
    for (const profile of Object.keys(profiles)) {
      if (only !== undefined && only !== `${profile}|light`) continue;
      await run(profile, "light", false);
    }
  });
});
