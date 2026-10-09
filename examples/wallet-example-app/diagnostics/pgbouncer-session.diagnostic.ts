// DIAGNOSTIC EXPERIMENT (docs/guides/run-in-production.md, "Behind a pooler"), not a test: it measures, it does not assert. Needs Docker and the image edoburu/pgbouncer.
// Run with:  node --test examples/wallet-example-app/diagnostics/pgbouncer-session.diagnostic.ts   and read the `DIAG` lines.
// The whole wallet (api, views, automations, outbox) with its connection pointed at PgBouncer 1.x in TRANSACTION mode (server pool of 4), twice: with the leader locks and LISTEN on a direct
// session connection (`Crablet.layer(pg, { session })`), and without it. Each run samples for 8 s which backend holds each leader lock (a lock that moves between backends means the leader
// kept losing it), and times 15 commands each followed by a consistent read of the view they feed (the read waits for the view's progress ping, which comes over LISTEN).
import { after, before, describe, it } from "node:test";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { execFileSync } from "node:child_process";
import { EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { AUTOMATIONS_LOCK_KEY, OUTBOX_LOCK_KEY, VIEWS_LOCK_KEY } from "@crablet/eventstore/Leader";
import { sessionClientsLayer } from "@crablet/eventstore/SessionClients";
import { CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startWalletAppForTest, type CoreServices } from "../test/support/startWalletAppForTest.ts";
import { applyAppMigrations } from "../test/support/applyAppMigrations.ts";

let db: TestDb;
let probe: Client;
let bouncer: { id: string; port: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => (xs.length === 0 ? NaN : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!);

before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  const id = execFileSync("docker", [
    "run", "-d", "--rm", "-p", "127.0.0.1::5432", "--add-host", "host.docker.internal:host-gateway",
    "-e", "DB_HOST=host.docker.internal", "-e", `DB_PORT=${db.connInfo.port}`, "-e", `DB_USER=${db.connInfo.username}`, "-e", `DB_PASSWORD=${db.connInfo.password}`, "-e", `DB_NAME=${db.connInfo.database}`,
    "-e", "POOL_MODE=transaction", "-e", "AUTH_TYPE=scram-sha-256", "-e", "DEFAULT_POOL_SIZE=4", "-e", "MAX_CLIENT_CONN=200", "-e", `ADMIN_USERS=${db.connInfo.username}`, "edoburu/pgbouncer:latest"
  ]).toString().trim();
  const port = Number(execFileSync("docker", ["port", id, "5432/tcp"]).toString().trim().split("\n")[0]!.split(":").pop());
  for (let i = 0; i < 50; i++) {
    const c = new Client({ host: "127.0.0.1", port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
    try { await c.connect(); await c.query("SELECT 1"); await c.end(); break; } catch { await sleep(200); }
  }
  bouncer = { id, port };
  probe = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password, application_name: "probe" });
  await probe.connect();
}, { timeout: 180_000 });
after(async () => { await probe.end(); execFileSync("docker", ["stop", "-t", "1", bouncer.id]); await db.stop(); });

const holders = async () => {
  const keys = [OUTBOX_LOCK_KEY, VIEWS_LOCK_KEY, AUTOMATIONS_LOCK_KEY].map(String);
  const r = await probe.query<{ key: string; pid: number }>(
    `SELECT (((classid::bigint << 32) | objid::bigint))::text AS key, pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND (((classid::bigint << 32) | objid::bigint)) = ANY($1::bigint[])`, [keys]
  );
  return new Map(r.rows.map((row) => [row.key, row.pid]));
};

const run = async (label: string, withSession: boolean) => {
  const pgcfg = (host: string, port: number) => ({ host, port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
  const appLayers = Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive, ...(withSession ? [sessionClientsLayer({ ...pgcfg(db.connInfo.host, db.connInfo.port), maxConnections: 5 })] : []));
  const runtime = ManagedRuntime.make(Layer.provideMerge(appLayers, PgClient.layer({ ...pgcfg("127.0.0.1", bouncer.port), maxConnections: 10 })) as unknown as Layer.Layer<CoreServices, never>);
  const app = await startWalletAppForTest(runtime);
  try {
    await sleep(1500);
    // 15 commands, each followed by a consistent read; the read is the wait for the view's ping
    const latencies: number[] = [];
    let failures = 0;
    const t0 = performance.now();
    const sampler = (async () => {
      const seen = new Map<string, Set<number>>();
      let samples = 0;
      while (performance.now() - t0 < 8000) {
        for (const [key, pid] of await holders()) { if (!seen.has(key)) seen.set(key, new Set()); seen.get(key)!.add(pid); }
        samples++;
        await sleep(100);
      }
      return { seen, samples };
    })();
    for (let i = 0; i < 15; i++) {
      const walletId = `w-${crypto.randomUUID()}`;
      const s = performance.now();
      const post = await fetch(`${app.baseUrl}/api/commands/open_wallet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletId, owner: "x", initialBalance: 1 }) });
      const read = await fetch(`${app.baseUrl}/api/wallets/${walletId}`);
      if (post.status !== 201 || read.status !== 200) failures++;
      latencies.push(performance.now() - s);
      await sleep(100);
    }
    const { seen, samples } = await sampler;
    const distinct = [...seen.values()].map((s) => s.size);
    console.log(`DIAG pgbouncer [${label}] leader locks seen held: ${seen.size}/3 in ${samples} samples; backends that held each lock over 8 s: ${JSON.stringify(distinct)} (1 each = stable)`);
    console.log(`DIAG pgbouncer [${label}] command + consistent read: ${latencies.length} done, ${failures} failed; p50 ${pct(latencies, 50).toFixed(0)} ms, p95 ${pct(latencies, 95).toFixed(0)} ms`);
  } finally {
    await app.stop();
    await runtime.dispose();
  }
};

describe("the wallet behind PgBouncer in transaction mode", () => {
  it("with the leader locks and LISTEN on a direct session connection", { timeout: 120_000 }, async () => { await run("session split", true); });
  it("control: everything through the pooler", { timeout: 120_000 }, async () => { await run("everything pooled", false); });
});
