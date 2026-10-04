// What a consistent read costs (docs/plans/read-consistency.md, phase 7). Starts the real course app on a throwaway Postgres (Testcontainers,
// needs Docker) and measures, with the load generator, the app and the database all on this machine:
//
//   1. reads on an idle log:        eventual (no wait) / latest (the server default) / a write's marker, at several concurrencies;
//   2. reads under a steady write load: latest against eventual;
//   3. waiters: N readers that all wait for one write while the seats view lags, and what that does to an unrelated read (the poll cost);
//   4. the head-of-log query on a large log.
//
//     node scripts/bench-reads.ts [--seconds 4] [--pool 10] [--events 2000000]
//
// The numbers are for comparing the modes with each other on one machine, not capacity figures: absolute throughput depends on the hardware
// and on the load generator sharing it. "xacts per read" is the database's transaction count (every statement here is its own transaction)
// divided by the reads served, minus the idle background rate: a proxy for how many queries a read costs.
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { Context, Effect, Exit, Layer, ManagedRuntime, Redacted, Scope } from "effect";
import type { SqlClient } from "effect/sql";
import { HttpRouter, HttpServer } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import { Client } from "pg";
import * as Crablet from "@crablet/commands/Crablet";
import { startTestDb, type ConnInfo } from "@crablet/test-support";
import { applyAppMigrations } from "../test/support/applyAppMigrations.ts";
import { makeCourseApiLayer, startCourseViews } from "../src/CourseApp.ts";

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const SECONDS = arg("seconds", 4);
const POOL = arg("pool", 10);
const EVENTS = arg("events", 2_000_000);
// `--only 2,3` runs just those scenarios (1 idle log, 2 under writes, 3 waiters, 4 head of log).
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? new Set(process.argv[onlyArg + 1]!.split(",").map(Number)) : null;
const wanted = (n: number) => only === null || only.has(n);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface App {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

// Like the tests' startCourseAppForTest, with a pool size and the view delay as parameters.
const startApp = async (conn: ConnInfo, options: { readonly pool: number; readonly viewDelayMs: number }): Promise<App> => {
  const runtime = ManagedRuntime.make(
    Crablet.layer({ host: conn.host, port: conn.port, database: conn.database, username: conn.username, password: Redacted.make(conn.password), maxConnections: options.pool })
  );
  const views = await runtime.runPromise(startCourseViews(undefined, { viewDelayMs: options.viewDelayMs }));
  const scope = await runtime.runPromise(Scope.make());
  const context = await runtime.runPromise(
    Scope.provide(
      Layer.build(
        Layer.provideMerge(HttpRouter.serve(makeCourseApiLayer({})), NodeHttpServer.layer(createServer, { port: 0, gracefulShutdownTimeout: "1 second" }))
      ) as Effect.Effect<Context.Context<HttpServer.HttpServer>, never, SqlClient.SqlClient>,
      scope
    ) as Effect.Effect<Context.Context<HttpServer.HttpServer>, never, never>
  );
  const server = Context.get(context, HttpServer.HttpServer);
  const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port;
  return {
    baseUrl: `http://localhost:${port}`,
    stop: async () => {
      await runtime.runPromise(views.service.stop);
      await runtime.runPromise(Effect.exit(Scope.close(scope, Exit.void)));
      await runtime.dispose();
    }
  };
};

const percentile = (sorted: ReadonlyArray<number>, p: number): number => (sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!);

interface LoadResult {
  readonly count: number;
  readonly ok: number;
  readonly statuses: Record<string, number>;
  readonly rps: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

// `concurrency` workers, each issuing one request after another until `ms` has passed.
const load = async (baseUrl: string, concurrency: number, ms: number, path: () => string): Promise<LoadResult> => {
  const latencies: Array<number> = [];
  const statuses: Record<string, number> = {};
  const until = performance.now() + ms;
  const started = performance.now();
  const worker = async () => {
    while (performance.now() < until) {
      const t0 = performance.now();
      let status = "error";
      try {
        const res = await fetch(`${baseUrl}${path()}`);
        status = String(res.status);
        await res.arrayBuffer();
      } catch {
        // counted as "error"
      }
      latencies.push(performance.now() - t0);
      statuses[status] = (statuses[status] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (performance.now() - started) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  return { count: latencies.length, ok: statuses["200"] ?? 0, statuses, rps: latencies.length / elapsed, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99) };
};

const fmt = (n: number, digits = 1) => (Number.isFinite(n) ? n.toFixed(digits) : "-");
const row = (cells: ReadonlyArray<string | number>, widths: ReadonlyArray<number>) => cells.map((c, i) => String(c).padEnd(widths[i]!)).join(" ");

const post = async (baseUrl: string, name: string, body: unknown): Promise<{ status: number; marker: string | null }> => {
  const res = await fetch(`${baseUrl}/api/commands/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as { marker?: string | null };
  return { status: res.status, marker: json.marker ?? null };
};

const main = async () => {
  console.log(`bench-reads: ${SECONDS}s per measurement, pool ${POOL}, ${process.version}, ${process.platform}/${process.arch}`);
  const db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  const stats = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await stats.connect();
  const xacts = async (): Promise<number> => {
    await sleep(2500); // the database flushes its counters about once a second, a busy backend later
    const r = await stats.query("SELECT (xact_commit + xact_rollback)::float8 AS x FROM pg_stat_database WHERE datname = current_database()");
    return r.rows[0].x as number;
  };
  const activeConnections = async (): Promise<number> =>
    Number((await stats.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()")).rows[0].n);

  try {
    // the database's own background rate with nothing running (the poller and the leader check), per second
    const idleApp = await startApp(db.connInfo, { pool: POOL, viewDelayMs: 0 });
    const idle0 = await xacts();
    await sleep(3000);
    const idleRate = ((await xacts()) - idle0) / (3 + 2.5);
    console.log(`\nidle background: ${fmt(idleRate)} transactions/s with no load`);

    // ---------------------------------------------------------------- 1. idle log
    const COURSES = 20;
    let lastMarker = "";
    for (let n = 0; n < COURSES; n++) lastMarker = (await post(idleApp.baseUrl, "define_course", { courseId: `bench-${n}`, capacity: 100 })).marker!;
    await fetch(`${idleApp.baseUrl}/api/courses/bench-${COURSES - 1}?consistentWith=${lastMarker}`); // the view has them all
    const pick = () => `bench-${Math.floor(Math.random() * COURSES)}`;

    if (wanted(1)) {
      console.log("\n1. reads on an idle log, GET /api/courses/{id} (the log is quiet and the view is caught up, so a wait returns at once)");
      const w1 = [9, 5, 8, 8, 8, 8, 11, 8];
      console.log(row(["mode", "conc", "reads/s", "p50 ms", "p95 ms", "p99 ms", "xacts/read", "non-200"], w1));
      const paths: ReadonlyArray<readonly [string, () => string]> = [
        ["eventual", () => `/api/courses/${pick()}?consistency=eventual`],
        ["latest", () => `/api/courses/${pick()}`],
        ["marker", () => `/api/courses/${pick()}?consistentWith=${lastMarker}`]
      ];
      for (const concurrency of [1, 8, 32]) {
        for (const [mode, path] of paths) {
          const before = await xacts();
          const t0 = performance.now();
          const r = await load(idleApp.baseUrl, concurrency, SECONDS * 1000, path);
          const seconds = (performance.now() - t0) / 1000;
          const after = await xacts();
          const perRead = (after - before - idleRate * (seconds + 2.5)) / r.count;
          console.log(row([mode, concurrency, fmt(r.rps, 0), fmt(r.p50, 2), fmt(r.p95, 2), fmt(r.p99, 2), fmt(perRead, 2), r.count - r.ok], w1));
        }
      }
    }

    // ---------------------------------------------------------------- 2. under writes
    if (wanted(2)) {
      console.log("\n2. reads under a steady write load (one writer, ~25 subscriptions/s, to one course); 16 readers of that course");
      await post(idleApp.baseUrl, "define_course", { courseId: "bench-w", capacity: 1_000_000 });
      await fetch(`${idleApp.baseUrl}/api/courses/bench-w`); // a default read waits until the view has the course, so no read below can 404
      const w2 = [9, 9, 8, 8, 8, 8];
      console.log(row(["mode", "reads/s", "p50 ms", "p95 ms", "p99 ms", "non-200"], w2));
      for (const [mode, path] of [
        ["eventual", () => "/api/courses/bench-w?consistency=eventual"],
        ["latest", () => "/api/courses/bench-w"]
      ] as const) {
        let stop = false;
        let writes = 0;
        const writer = (async () => {
          while (!stop) {
            const t0 = performance.now();
            await post(idleApp.baseUrl, "subscribe", { studentId: `s-${crypto.randomUUID()}`, courseId: "bench-w" });
            writes++;
            await sleep(Math.max(0, 40 - (performance.now() - t0)));
          }
        })();
        const r = await load(idleApp.baseUrl, 16, SECONDS * 1000, path);
        stop = true;
        await writer;
        console.log(row([mode, fmt(r.rps, 0), fmt(r.p50, 2), fmt(r.p95, 2), fmt(r.p99, 2), r.count - r.ok], w2), `  statuses ${JSON.stringify(r.statuses)}, ${writes} writes in the window`);
      }
    }
    await idleApp.stop();

    // ---------------------------------------------------------------- 3. waiters
    if (wanted(3)) {
      console.log("\n3. waiters: the seats view lags 400 ms; one write, then N readers all ask for that write's marker at once and wait; one unrelated reader (eventual) runs alongside");
      const w3 = [6, 5, 8, 8, 8, 8, 11, 10, 10];
      console.log(row(["pool", "N", "p50 ms", "p95 ms", "max ms", "non-200", "peak conns", "xacts/s", "probe p95"], w3));
      for (const pool of [POOL, POOL * 3]) {
        const slow = await startApp(db.connInfo, { pool, viewDelayMs: 400 });
        await post(slow.baseUrl, "define_course", { courseId: "probe", capacity: 10 });
        await sleep(1500);
        const quiet = await load(slow.baseUrl, 1, 1500, () => "/api/courses/probe?consistency=eventual");
        for (const n of [1, 10, 50, 200]) {
          const before = await xacts(); // BEFORE the write: reading the counter takes seconds, and the view would catch up meanwhile
          const t0 = performance.now();
          const { marker } = await post(slow.baseUrl, "define_course", { courseId: `wait-${pool}-${n}-${crypto.randomUUID().slice(0, 6)}`, capacity: 5 });
          const writtenAt = performance.now();
          let peak = 0;
          const sampler = (async () => {
            while (performance.now() - writtenAt < 1500) {
              peak = Math.max(peak, await activeConnections());
              await sleep(50);
            }
          })();
          const waiters = Array.from({ length: n }, async () => {
            const started = performance.now();
            const res = await fetch(`${slow.baseUrl}/api/courses/probe?consistentWith=${marker}`);
            await res.arrayBuffer();
            return { ms: performance.now() - started, status: res.status };
          });
          const probe = load(slow.baseUrl, 1, 1200, () => "/api/courses/probe?consistency=eventual");
          const results = await Promise.all(waiters);
          const probed = await probe;
          await sampler;
          const seconds = (performance.now() - t0) / 1000;
          const after = await xacts();
          const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
          console.log(
            row([pool, n, fmt(percentile(sorted, 50), 0), fmt(percentile(sorted, 95), 0), fmt(sorted[sorted.length - 1]!, 0), results.filter((r) => r.status !== 200).length, peak, fmt((after - before - idleRate * (seconds + 2.5)) / seconds, 0), fmt(probed.p95, 1)], w3)
          );
        }
        console.log(`     (unrelated eventual reader with nothing else running, pool ${pool}: p95 ${fmt(quiet.p95, 1)} ms)`);
        await slow.stop();
      }
    }

    // ---------------------------------------------------------------- 4. head of log
    if (wanted(4)) {
      console.log(`\n4. the head-of-log query on a log of ${EVENTS.toLocaleString()} events`);
      await stats.query("SET statement_timeout = 0");
      const batch = 250_000;
      for (let inserted = 0; inserted < EVENTS; inserted += batch) {
        await stats.query(
          `INSERT INTO crablet_events (type, tags, data, transaction_id)
           SELECT 'BenchEvent', ARRAY['k=' || (g % 1000)], '{}'::jsonb, pg_current_xact_id() FROM generate_series(1, $1) g`,
          [Math.min(batch, EVENTS - inserted)]
        );
      }
      await stats.query("ANALYZE crablet_events");
      const headSql = "SELECT transaction_id::text AS transaction_id_text, position::text AS position_text FROM crablet_events ORDER BY transaction_id DESC, position DESC LIMIT 1";
      const times: Array<number> = [];
      for (let i = 0; i < 2000; i++) {
        const t0 = performance.now();
        await stats.query(headSql);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      console.log(`   2000 runs, one connection: p50 ${fmt(percentile(times, 50), 3)} ms, p99 ${fmt(percentile(times, 99), 3)} ms, max ${fmt(times[times.length - 1]!, 3)} ms`);
      const plan = await stats.query(`EXPLAIN (ANALYZE, BUFFERS) ${headSql}`);
      console.log(plan.rows.map((r) => `   ${r["QUERY PLAN"]}`).join("\n"));
    }
  } finally {
    await stats.end();
    await db.stop();
  }
};

await main();
