// Runs under Node (Testcontainers + the docker CLI, and the image edoburu/pgbouncer) - see NOTES.md. The whole wallet behind PgBouncer in TRANSACTION mode, the way a deployment with a pooler runs it
// (docs/guides/run-in-production.md, "Behind a pooler"; ADR-0024): TWO instances, each with the application's connection going through the pooler (a server pool of 8) and the leader locks and LISTEN
// on a direct session connection (a pool of 10: it holds 3 leader locks and 4 LISTEN for good).
//
// The load, through both instances: opens, deposits, withdrawals, transfers and a deposit id sent twice at once; then a CONTENTION phase, 240 debits (withdrawals and transfers, which are strict over a
// wallet's boundary) on just 3 wallets, 16 at once, which conflicts for real: the test requires that the database ran transactions side by side, that the conflicts were retried, and that the ones that
// ran out of retries answered 409 and nothing else went wrong. In the middle of more load the session connection of every leader is killed, and then one instance is stopped gracefully.
//
// At the end: one leader per role each time, always on a session connection and never on a pooled one; the other instance takes over; no 5xx; and the data is consistent: the same checks the kind lab's
// chaos page runs (examples/chaos-ui/server/checks.ts: the views equal the sum of the log, no duplicate deposits, one welcome notification per wallet, every transaction of events audited).
//
// Two things this test taught, both in NOTES.md: the session pool must hold what the process keeps for good (7), and PgBouncer must be given the database's IPv4 address, or it serialises everything.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Metric, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { execFileSync } from "node:child_process";
import { EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { AUTOMATIONS_LOCK_KEY, OUTBOX_LOCK_KEY, VIEWS_LOCK_KEY } from "@crablet/eventstore/Leader";
import { sessionClientsLayer } from "@crablet/eventstore/SessionClients";
// (the wallet does not depend on the metrics package; these are the very files the framework counts with)
import * as CommandMetrics from "../../../../packages/metrics-otel/src/CommandMetrics.ts";
import { CommandExecutorLive } from "@crablet/commands";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { dataChecks } from "../../../chaos-ui/server/checks.ts";
import { startWalletAppForTest, type CoreServices, type RunningWalletApp } from "../support/startWalletAppForTest.ts";
import { applyAppMigrations } from "../support/applyAppMigrations.ts";

let db: TestDb;
let probe: Client;
let bouncer: { id: string; port: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOCKS = { outbox: OUTBOX_LOCK_KEY, views: VIEWS_LOCK_KEY, automations: AUTOMATIONS_LOCK_KEY };

const connect = async (port: number, host: string, user: string, database: string, applicationName: string) => {
  const c = new Client({ host, port, database, user, password: db.connInfo.password, application_name: applicationName });
  await c.connect();
  return c;
};

// The database's address as the PgBouncer container sees it, as an IPv4 LITERAL. `host.docker.internal` (Docker Desktop) resolves to an IPv6 address as well, PgBouncer tries it first, gets
// "Network unreachable", and waits `server_login_retry` (15 s) before the next attempt: it then opens one server connection every 15 s and runs everything on that one, serialised. The
// earlier version of this test, and of the diagnostic, ran like that without anyone noticing (20 transactions of 300 ms took 6 s instead of 1).
const hostIPv4 = (): string =>
  execFileSync("docker", ["run", "--rm", "--add-host", "host.docker.internal:host-gateway", "--entrypoint", "sh", "edoburu/pgbouncer:latest", "-c", "getent ahostsv4 host.docker.internal | awk 'NR==1{print $1}'"]).toString().trim();

before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  const id = execFileSync("docker", [
    "run", "-d", "--rm", "-p", "127.0.0.1::5432", "--add-host", "host.docker.internal:host-gateway",
    "-e", `DB_HOST=${hostIPv4()}`, "-e", `DB_PORT=${db.connInfo.port}`, "-e", `DB_USER=${db.connInfo.username}`, "-e", `DB_PASSWORD=${db.connInfo.password}`, "-e", `DB_NAME=${db.connInfo.database}`,
    "-e", "POOL_MODE=transaction", "-e", "AUTH_TYPE=scram-sha-256", "-e", "DEFAULT_POOL_SIZE=8", "-e", "MIN_POOL_SIZE=8", "-e", "MAX_CLIENT_CONN=200", "-e", `ADMIN_USERS=${db.connInfo.username}`, "edoburu/pgbouncer:latest"
  ]).toString().trim();
  const port = Number(execFileSync("docker", ["port", id, "5432/tcp"]).toString().trim().split("\n")[0]!.split(":").pop());
  bouncer = { id, port };
  for (let i = 0; i < 100; i++) {
    try { const c = await connect(port, "127.0.0.1", db.connInfo.username, db.connInfo.database, "ready"); await c.query("SELECT 1"); await c.end(); break; } catch { await sleep(200); }
  }
  probe = await connect(db.connInfo.port, db.connInfo.host, db.connInfo.username, db.connInfo.database, "probe");
}, { timeout: 180_000 });
after(async () => {
  await probe.end();
  try { execFileSync("docker", ["stop", "-t", "1", bouncer.id]); } catch { /* it removes itself */ }
  await db.stop();
});

interface Instance { readonly name: string; readonly app: RunningWalletApp; readonly runtime: ManagedRuntime.ManagedRuntime<CoreServices, never> }

const startInstance = async (name: string): Promise<Instance> => {
  const direct = { host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) };
  const pooled = { host: "127.0.0.1", port: bouncer.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) };
  const layers = Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive, sessionClientsLayer({ ...direct, applicationName: `session-${name}`, maxConnections: 10 }));
  const runtime = ManagedRuntime.make(Layer.provideMerge(layers, PgClient.layer({ ...pooled, applicationName: `main-${name}`, maxConnections: 10 })) as unknown as Layer.Layer<CoreServices, never>);
  const app = await startWalletAppForTest(runtime, undefined, undefined, { instanceId: name, polling: { pollingIntervalMs: 100, backoffMaxSeconds: 1 } });
  return { name, app, runtime };
};

// who holds each leader lock right now: role -> { pid, application_name }
const holders = async () => {
  const keys = Object.values(LOCKS).map(String);
  const r = await probe.query<{ key: string; pid: number; application_name: string }>(
    `SELECT (((l.classid::bigint << 32) | l.objid::bigint))::text AS key, l.pid, a.application_name
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND (((l.classid::bigint << 32) | l.objid::bigint)) = ANY($1::bigint[])`, [keys]
  );
  const byRole = new Map<string, { pid: number; application_name: string }>();
  for (const [role, key] of Object.entries(LOCKS)) {
    const row = r.rows.find((x) => x.key === String(key));
    if (row !== undefined) byRole.set(role, { pid: row.pid, application_name: row.application_name });
  }
  return byRole;
};

const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 60_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}; last: ${JSON.stringify(v, (_k, x) => (x instanceof Map ? [...x] : x))}`);
    await sleep(250);
  }
};

describe("the wallet behind PgBouncer in transaction mode, two instances, leaders killed under load", () => {
  it("keeps the data consistent, and the leader locks and LISTEN only ever sit on the session connections", { timeout: 360_000 }, async () => {
    const a = await startInstance("A");
    const b = await startInstance("B");
    let live = [a, b]; // the instances still running; A is stopped part-way
    let aStopped = false;
    try {
      // 1. one leader per role, each on a SESSION connection
      const first = await until(holders, (h) => h.size === 3, "the three leader locks to be taken");
      for (const [role, h] of first) assert.match(h.application_name, /^session-[AB]$/, `the ${role} leader lock is held by ${h.application_name}`);

      // 2. mixed load through both instances
      const statuses = new Map<number, number>();
      let inflight = 0, maxInflight = 0;
      const call = async (i: number, command: string, body: unknown) => {
        inflight++; maxInflight = Math.max(maxInflight, inflight);
        const target = live[i % live.length]!;
        const res = await fetch(`${target.app.baseUrl}/api/commands/${command}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        await res.text();
        inflight--;
        return res.status;
      };
      const wallets = Array.from({ length: 12 }, () => `wallet-${crypto.randomUUID()}`);
      await Promise.all(wallets.map((id, i) => call(i, "open_wallet", { walletId: id, owner: "Ana", initialBalance: 100_000 })));
      assert.strictEqual(statuses.get(201), wallets.length, "every wallet opened");

      let counter = 0;
      const pick = () => wallets[Math.floor(Math.random() * wallets.length)]!;
      const operation = async () => {
        const n = counter++;
        const kind = n % 10;
        if (kind < 4) return call(n, "deposit", { depositId: crypto.randomUUID(), walletId: pick(), amount: 1 + (n % 9), description: "d" });
        if (kind < 6) return call(n, "withdraw", { withdrawalId: crypto.randomUUID(), walletId: pick(), amount: 1 + (n % 5), description: "w" });
        if (kind < 9) {
          const from = pick();
          let to = pick();
          while (to === from) to = pick();
          return call(n, "transfer_money", { transferId: crypto.randomUUID(), fromWalletId: from, toWalletId: to, amount: 1 + (n % 5), description: "t" });
        }
        // the same deposit id sent twice at once, through both instances: one deposit
        const depositId = crypto.randomUUID();
        const walletId = pick();
        return Promise.all([call(0, "deposit", { depositId, walletId, amount: 3, description: "twice" }), call(1, "deposit", { depositId, walletId, amount: 3, description: "twice" })]);
      };
      const burst = async (count: number) => {
        let issued = 0;
        const workers = Array.from({ length: 8 }, async () => { while (issued++ < count) await operation(); });
        await Promise.all(workers);
      };

      await burst(60);

      // 2b. contention: debits (withdrawals, transfers) are strict over the wallet's boundary, so many of them at once on a FEW wallets conflict. They retry (3 times), and what still
      // conflicts is a 409. Counted two ways, because the retries hide conflicts that then succeed: the 409s, and the transactions the database rolled back.
      const HOT = 3, WORKERS = 16;
      const hot = Array.from({ length: HOT }, () => `hot-${crypto.randomUUID()}`);
      await Promise.all(hot.map((id, i) => call(i, "open_wallet", { walletId: id, owner: "Hot", initialBalance: 10_000_000 })));
      const rollbacks = async () => {
        await sleep(1_500); // the database publishes its counters about once a second
        return Number((await probe.query("SELECT xact_rollback::text AS n FROM pg_stat_database WHERE datname = current_database()")).rows[0].n);
      };
      const contend = async (count: number) => {
        let issued = 0;
        const workers = Array.from({ length: WORKERS }, async () => {
          while (issued < count) {
            const n = issued++;
            const from = hot[n % hot.length]!;
            if (n % 5 < 3) await call(n, "withdraw", { withdrawalId: crypto.randomUUID(), walletId: from, amount: 1 + (n % 3), description: "hot" });
            else await call(n, "transfer_money", { transferId: crypto.randomUUID(), fromWalletId: from, toWalletId: hot[(n + 1) % hot.length]!, amount: 1 + (n % 3), description: "hot" });
          }
        });
        await Promise.all(workers);
      };
      const rolledBackBefore = await rollbacks();
      const conflictsBefore = statuses.get(409) ?? 0;
      let sampling = true, maxActive = 0, maxWaitingOnLock = 0;
      const sampler = (async () => {
        while (sampling) {
          const r = await probe.query<{ active: string; locks: string }>(
            `SELECT count(*) FILTER (WHERE state IN ('active', 'idle in transaction'))::text AS active, count(*) FILTER (WHERE wait_event_type = 'Lock')::text AS locks FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`
          );
          maxActive = Math.max(maxActive, Number(r.rows[0]!.active));
          maxWaitingOnLock = Math.max(maxWaitingOnLock, Number(r.rows[0]!.locks));
          await sleep(10);
        }
      })();
      const admin0 = await connect(bouncer.port, "127.0.0.1", db.connInfo.username, "pgbouncer", "admin-pool");
      let maxClWaiting = 0, maxSvActive = 0;
      const poolSampler = (async () => {
        while (sampling) {
          const pools = await admin0.query("SHOW POOLS");
          const row = pools.rows.find((r: { database: string }) => r.database === db.connInfo.database) as { cl_active: number; cl_waiting: number; sv_active: number } | undefined;
          if (row) { maxClWaiting = Math.max(maxClWaiting, Number(row.cl_waiting)); maxSvActive = Math.max(maxSvActive, Number(row.sv_active)); }
          await sleep(20);
        }
      })();
      const contentionStarted = Date.now();
      await contend(240);
      const contentionMs = Date.now() - contentionStarted;
      sampling = false;
      await sampler;
      await poolSampler;
      await admin0.end();
      console.log(`DIAG pgbouncer e2e contention load: ${contentionMs} ms for 240 debits; at most ${maxInflight} requests in flight; at most ${maxActive} active database sessions and ${maxWaitingOnLock} waiting on a lock; PgBouncer: at most ${maxSvActive} server connections active, ${maxClWaiting} clients waiting for one`);
      const conflicts = (statuses.get(409) ?? 0) - conflictsBefore;
      const rolledBack = (await rollbacks()) - rolledBackBefore;
      const retriesOf = async (inst: Instance, command: string) =>
        (await inst.runtime.runPromise(Effect.map(Metric.value(Metric.withAttributes(CommandMetrics.conflictRetries, { command_type: command })), (m) => (m as unknown as { count: number }).count) as Effect.Effect<number, never, CoreServices>)) as number;
      // (the metrics are the process's, shared by both instances: read once)
      const retries = (await retriesOf(a, "withdraw")) + (await retriesOf(a, "transfer_money"));
      console.log(`DIAG pgbouncer e2e contention: 240 debits on ${HOT} wallets, ${WORKERS} at once, took ${contentionMs} ms: ${conflicts} answered 409, ${retries} conflicts were retried, ${rolledBack} transactions rolled back by the database; at most ${maxActive} database sessions in a transaction at once and ${maxWaitingOnLock} waiting on a lock; PgBouncer: at most ${maxSvActive} server connections active, ${maxClWaiting} clients waiting for one`);
      assert.ok(maxSvActive >= 2 && maxActive >= 2, `PgBouncer ran transactions side by side (server connections active at once: ${maxSvActive}, sessions in a transaction: ${maxActive}); one at a time would mean the load never contended`);
      assert.ok(retries >= 10, `the debits conflicted for real and were retried (${retries} retries, ${conflicts} answered 409)`);

      // 3. kill the session connection of each role's leader, in the middle of the load
      const leadersBefore = await holders();
      const killed = [...leadersBefore.entries()].map(([role, h]) => ({ role, pid: h.pid, instance: h.application_name }));
      const loading = burst(120);
      await sleep(300);
      for (const k of killed) await probe.query("SELECT pg_terminate_backend($1)", [k.pid]);
      await loading;

      // 4. every role has a leader again, on a session connection (the same instance reconnecting, or the other one taking over)
      const leadersAfter = await until(holders, (h) => h.size === 3 && [...h].every(([role, x]) => x.pid !== leadersBefore.get(role)!.pid), "a new leader for every role", 90_000);
      for (const [role, h] of leadersAfter) assert.match(h.application_name, /^session-[AB]$/, `the ${role} leader lock is held by ${h.application_name}`);
      console.log(`DIAG pgbouncer e2e: leaders before ${JSON.stringify(killed.map((k) => `${k.role}@${k.instance}`))}, after ${JSON.stringify([...leadersAfter].map(([r, h]) => `${r}@${h.application_name}`))}; statuses ${JSON.stringify([...statuses])}`);

      // 4b. stop instance A, gracefully, under load: B must take over every role, on its own session connections, and carry on
      const stopping = burst(60);
      await sleep(200);
      aStopped = true;
      live = [b];
      await a.app.stop();
      await a.runtime.dispose();
      await stopping;
      const takenOver = await until(holders, (h) => h.size === 3 && [...h.values()].every((x) => x.application_name === "session-B"), "instance B to hold all three leader locks", 60_000);
      console.log(`DIAG pgbouncer e2e: after stopping A, ${JSON.stringify([...takenOver].map(([r, h]) => `${r}@${h.application_name}`))}`);
      await burst(60); // only B now
      assert.ok((statuses.get(201) ?? 0) > 300, `the load carried on through B (${JSON.stringify([...statuses])})`);

      // nothing of the load was a server error
      assert.deepStrictEqual([...statuses.keys()].filter((s) => s >= 500), [], `no 5xx among ${JSON.stringify([...statuses])}`);

      // 5. everything caught up: the views, the welcome notifications, the outbox
      const settled = await until(
        async () => {
          const checks = await dataChecks(probe);
          const bad = checks.filter((c) => !c.ok && !c.info);
          const outbox = await probe.query(
            `SELECT count(*)::int AS stuck FROM crablet_outbox_topic_progress p
              WHERE (p.last_transaction_id, p.last_position) <> (SELECT transaction_id, position FROM crablet_events ORDER BY transaction_id DESC, position DESC LIMIT 1)`
          );
          return { bad: bad.map((c) => `${c.name}: ${c.detail}`), outboxBehind: (outbox.rows[0] as { stuck: number }).stuck };
        },
        (s) => s.bad.length === 0 && s.outboxBehind === 0,
        "the data to be consistent and every processor caught up",
        90_000
      );
      assert.deepStrictEqual(settled.bad, []);

      // no processor failed or counted an error
      for (const [table, id] of [["crablet_view_progress", "view_name"], ["crablet_automation_progress", "automation_name"]] as const) {
        const rows = await probe.query<{ id: string; status: string; error_count: number }>(`SELECT ${id} AS id, status, error_count FROM ${table}`);
        assert.deepStrictEqual(rows.rows.filter((r) => r.status !== "ACTIVE"), [], `${table}: all ACTIVE`);
      }

      // 6. the application's own connections never held a leader lock or a LISTEN; the pooler really was in the path
      const mainHeld = await probe.query<{ application_name: string }>(
        `SELECT a.application_name FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.locktype = 'advisory' AND l.granted AND a.application_name LIKE 'main-%'`
      );
      assert.deepStrictEqual(mainHeld.rows, [], "no advisory lock of a session is held by the application's pooled connections");
      const listeners = await probe.query<{ application_name: string }>(`SELECT DISTINCT application_name FROM pg_stat_activity WHERE query ILIKE 'LISTEN%' AND state = 'idle'`);
      assert.deepStrictEqual(listeners.rows.map((r) => r.application_name).filter((n) => n.startsWith("main-")), [], "no LISTEN on the pooled connections");
      const admin = await connect(bouncer.port, "127.0.0.1", db.connInfo.username, "pgbouncer", "admin");
      try {
        const stats = await admin.query("SHOW STATS");
        const mine = stats.rows.find((r: { database: string }) => r.database === db.connInfo.database) as { total_xact_count: string } | undefined;
        assert.ok(mine !== undefined && Number(mine.total_xact_count) > 200, `the pooler carried the application's transactions (${mine?.total_xact_count})`);
        const pools = await admin.query("SHOW POOLS");
        const pool = pools.rows.find((r: { database: string }) => r.database === db.connInfo.database) as { sv_active: number; sv_idle: number; sv_used: number } | undefined;
        assert.ok(pool !== undefined && Number(pool.sv_active) + Number(pool.sv_idle) + Number(pool.sv_used) <= 8, "never more than the pool's 8 server connections");
      } finally {
        await admin.end();
      }
    } finally {
      if (!aStopped) { await a.app.stop(); await a.runtime.dispose(); }
      await b.app.stop();
      await b.runtime.dispose();
    }
  });
});
