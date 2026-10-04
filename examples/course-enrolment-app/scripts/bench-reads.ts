// What a consistent read costs (docs/plans/read-consistency.md phase 7, docs/plans/shared-listener.md phase 4). Starts the real course app on a
// throwaway Postgres (Testcontainers, needs Docker) and measures, with the load generator, the app and the database all on this machine:
//
//   1. reads on an idle log:        eventual (no wait) / latest (the server default) / a write's marker, at several concurrencies;
//   2. reads under a steady write load: latest against eventual;
//   3. waiters: N readers that all wait for one write while the seats view lags, and what that does to an unrelated read (connections warmed first);
//   4. the head-of-log query on a large log;
//   5. open live feeds: how many database sessions N open feeds hold;
//   6. read your own write: a write, then a read carrying its marker, one after the other: how long the read takes.
//
// Scenarios 1-3 run twice: with the wait POLLING the database every 25 ms ("polling": the app's view progress hub is replaced by one that is never
// connected) and with the wait woken by the view progress hub's pings ("hub", ADR-0016), one after the other in the same session so they compare.
//
//     node scripts/bench-reads.ts [--seconds 4] [--pool 10] [--events 2000000] [--only 1,2,3,4,5]
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
import { ViewProgressHub } from "@crablet/views/ViewProgressHub";
import { makeCourseApiLayer, startCourseViews } from "../src/CourseApp.ts";

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const SECONDS = arg("seconds", 4);
const POOL = arg("pool", 10);
const EVENTS = arg("events", 2_000_000);
// `--only 2,3` runs just those scenarios (1 idle log, 2 under writes, 3 waiters, 4 head of log, 5 open feeds, 6 read your own write).
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? new Set(process.argv[onlyArg + 1]!.split(",").map(Number)) : null;
const wanted = (n: number) => only === null || only.has(n);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface App {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

type WaitMode = "polling" | "hub";

// A hub that is never connected and never delivers: `waitUntilProcessed` treats it as no hub and polls, exactly as before ADR-0016.
const neverConnectedHub = Layer.succeed(ViewProgressHub, {
  subscribe: () => Effect.succeed({ next: Effect.never }),
  connected: Effect.succeed(false),
  subscriberCount: Effect.succeed(0)
});

// Like the tests' startCourseAppForTest, with a pool size, the view delay and the wait mode as parameters.
const startApp = async (conn: ConnInfo, options: { readonly pool: number; readonly viewDelayMs: number; readonly wait: WaitMode }): Promise<App> => {
  const runtime = ManagedRuntime.make(
    Crablet.layer({ host: conn.host, port: conn.port, database: conn.database, username: conn.username, password: Redacted.make(conn.password), maxConnections: options.pool })
  );
  const views = await runtime.runPromise(startCourseViews(undefined, { viewDelayMs: options.viewDelayMs }));
  const scope = await runtime.runPromise(Scope.make());
  const context = await runtime.runPromise(
    Scope.provide(
      Layer.build(
        Layer.provideMerge(HttpRouter.serve(makeCourseApiLayer(options.wait === "polling" ? { viewProgressHub: neverConnectedHub } : {})), NodeHttpServer.layer(createServer, { port: 0, gracefulShutdownTimeout: "1 second" }))
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
const load = async (baseUrl: string, concurrency: number, ms: number, path: () => string, pauseMs = 0): Promise<LoadResult> => {
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
      if (pauseMs > 0) await sleep(pauseMs);
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
  const sessions = async (): Promise<number> =>
    Number((await stats.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()")).rows[0].n);

  try {
    // seed once; every app below finds the courses already in the view
    const seedApp = await startApp(db.connInfo, { pool: POOL, viewDelayMs: 0, wait: "hub" });
    const COURSES = 20;
    let lastMarker = "";
    for (let n = 0; n < COURSES; n++) lastMarker = (await post(seedApp.baseUrl, "define_course", { courseId: `bench-${n}`, capacity: 100 })).marker!;
    await fetch(`${seedApp.baseUrl}/api/courses/bench-${COURSES - 1}?consistentWith=${lastMarker}`);
    await post(seedApp.baseUrl, "define_course", { courseId: "bench-w", capacity: 1_000_000 });
    await fetch(`${seedApp.baseUrl}/api/courses/bench-w`);
    await seedApp.stop();
    const pick = () => `bench-${Math.floor(Math.random() * COURSES)}`;

    const measureIdleRate = async (app: App) => {
      const t0 = await xacts();
      await sleep(3000);
      void app;
      return ((await xacts()) - t0) / (3 + 2.5);
    };

    // ---------------------------------------------------------------- 1. idle log
    if (wanted(1)) {
      console.log("\n1. reads on an idle log, GET /api/courses/{id} (the log is quiet and the view is caught up, so a wait returns at once)");
      const w1 = [18, 5, 8, 8, 8, 8, 11, 8];
      console.log(row(["mode", "conc", "reads/s", "p50 ms", "p95 ms", "p99 ms", "xacts/read", "non-200"], w1));
      for (const wait of ["polling", "hub"] as const) {
        const app = await startApp(db.connInfo, { pool: POOL, viewDelayMs: 0, wait });
        const idleRate = await measureIdleRate(app);
        const paths: ReadonlyArray<readonly [string, () => string]> = [
          ...(wait === "polling" ? ([["eventual", () => `/api/courses/${pick()}?consistency=eventual`]] as const) : []),
          [`latest (${wait})`, () => `/api/courses/${pick()}`],
          [`marker (${wait})`, () => `/api/courses/${pick()}?consistentWith=${lastMarker}`]
        ];
        for (const concurrency of [1, 8, 32]) {
          for (const [mode, path] of paths) {
            const before = await xacts();
            const t0 = performance.now();
            const r = await load(app.baseUrl, concurrency, SECONDS * 1000, path);
            const seconds = (performance.now() - t0) / 1000;
            const after = await xacts();
            const perRead = (after - before - idleRate * (seconds + 2.5)) / r.count;
            console.log(row([mode, concurrency, fmt(r.rps, 0), fmt(r.p50, 2), fmt(r.p95, 2), fmt(r.p99, 2), fmt(perRead, 2), r.count - r.ok], w1));
          }
        }
        await app.stop();
      }
    }

    // ---------------------------------------------------------------- 2. under writes
    if (wanted(2)) {
      console.log("\n2. reads under a steady write load (one writer, ~25 subscriptions/s, to one course); 16 readers of that course");
      const w2 = [18, 9, 8, 8, 8, 8];
      console.log(row(["mode", "reads/s", "p50 ms", "p95 ms", "p99 ms", "non-200"], w2));
      for (const wait of ["polling", "hub"] as const) {
        const app = await startApp(db.connInfo, { pool: POOL, viewDelayMs: 0, wait });
        const modes: ReadonlyArray<readonly [string, () => string]> = [
          ...(wait === "polling" ? ([["eventual", () => "/api/courses/bench-w?consistency=eventual"]] as const) : []),
          [`latest (${wait})`, () => "/api/courses/bench-w"]
        ];
        for (const [mode, path] of modes) {
          let stop = false;
          let writes = 0;
          const writer = (async () => {
            while (!stop) {
              const t0 = performance.now();
              await post(app.baseUrl, "subscribe", { studentId: `s-${crypto.randomUUID()}`, courseId: "bench-w" });
              writes++;
              await sleep(Math.max(0, 40 - (performance.now() - t0)));
            }
          })();
          const r = await load(app.baseUrl, 16, SECONDS * 1000, path);
          stop = true;
          await writer;
          console.log(row([mode, fmt(r.rps, 0), fmt(r.p50, 2), fmt(r.p95, 2), fmt(r.p99, 2), r.count - r.ok], w2), `  statuses ${JSON.stringify(r.statuses)}, ${writes} writes in the window`);
        }
        await app.stop();
      }
    }

    // ---------------------------------------------------------------- 3. waiters
    if (wanted(3)) {
      console.log("\n3. waiters: the seats view lags 400 ms; one write, then N readers all ask for that write's marker at once and wait; one unrelated reader (eventual) runs alongside");
      const w3 = [9, 5, 8, 8, 8, 8, 11, 10, 10];
      console.log(row(["wait", "N", "p50 ms", "p95 ms", "max ms", "non-200", "peak sess.", "xacts/s", "probe p95"], w3));
      for (const wait of ["polling", "hub"] as const) {
        const slow = await startApp(db.connInfo, { pool: POOL, viewDelayMs: 400, wait });
        const idleRate = await measureIdleRate(slow);
        await post(slow.baseUrl, "define_course", { courseId: "probe", capacity: 10 });
        await sleep(1500);
        for (const n of [1, 10, 50, 200]) {
          const before = await xacts(); // BEFORE the write: reading the counter takes seconds, and the view would catch up meanwhile
          const t0 = performance.now();
          // WARM the N connections first. Opening N fresh TCP connections costs real CPU in this single process (the app, the view's own batch and the
          // load generator share one event loop): with 200 cold connections a burst took twice as long and the view's batch was delayed with it, which
          // an earlier version of this benchmark mistook for the cost of waiting. The N warm-up reads are one query each and are subtracted below.
          await Promise.all(Array.from({ length: n }, async () => (await fetch(`${slow.baseUrl}/api/courses/probe?consistency=eventual`)).arrayBuffer()));
          const { marker } = await post(slow.baseUrl, "define_course", { courseId: `wait-${wait}-${n}-${crypto.randomUUID().slice(0, 6)}`, capacity: 5 });
          const writtenAt = performance.now();
          let peak = 0;
          const sampler = (async () => {
            while (performance.now() - writtenAt < 1500) {
              peak = Math.max(peak, await sessions());
              await sleep(50);
            }
          })();
          const waiters = Array.from({ length: n }, async () => {
            const started = performance.now();
            const res = await fetch(`${slow.baseUrl}/api/courses/probe?consistentWith=${marker}`);
            await res.arrayBuffer();
            return { ms: performance.now() - started, status: res.status };
          });
          // the probe is paced (about 40 reads/s): a probe looping flat out is ~1,200 transactions/s and would swamp the waiters' own cost in the counter
          const probe = load(slow.baseUrl, 1, 1200, () => "/api/courses/probe?consistency=eventual", 25);
          const results = await Promise.all(waiters);
          const probed = await probe;
          await sampler;
          const seconds = (performance.now() - t0) / 1000;
          const after = await xacts();
          const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
          console.log(
            row([wait, n, fmt(percentile(sorted, 50), 0), fmt(percentile(sorted, 95), 0), fmt(sorted[sorted.length - 1]!, 0), results.filter((r) => r.status !== 200).length, peak, fmt((after - before - idleRate * (seconds + 2.5) - n) / seconds, 0), fmt(probed.p95, 1)], w3)
          );
        }
        await slow.stop();
      }
    }

    // ---------------------------------------------------------------- 6. read your own write
    if (wanted(6)) {
      console.log("\n6. read your own write: a write, then at once a read that carries its marker (no other load, the view applies the write by itself); 300 rounds each");
      const w6 = [9, 8, 8, 8, 8, 8];
      console.log(row(["wait", "p50 ms", "p90 ms", "p95 ms", "p99 ms", "mean ms"], w6));
      for (const wait of ["polling", "hub"] as const) {
        const app = await startApp(db.connInfo, { pool: POOL, viewDelayMs: 0, wait });
        await sleep(500);
        const times: Array<number> = [];
        for (let n = 0; n < 300; n++) {
          const { marker } = await post(app.baseUrl, "define_course", { courseId: `ryow-${wait}-${n}-${crypto.randomUUID().slice(0, 6)}`, capacity: 5 });
          const t0 = performance.now();
          const res = await fetch(`${app.baseUrl}/api/courses/bench-0?consistentWith=${marker}`);
          await res.arrayBuffer();
          times.push(performance.now() - t0);
          await sleep(20);
        }
        const sorted = [...times].sort((a, b) => a - b);
        console.log(row([wait, fmt(percentile(sorted, 50), 1), fmt(percentile(sorted, 90), 1), fmt(percentile(sorted, 95), 1), fmt(percentile(sorted, 99), 1), fmt(times.reduce((a, b) => a + b, 0) / times.length, 1)], w6));
        await app.stop();
      }
    }

    // ---------------------------------------------------------------- 5. open feeds
    if (wanted(5)) {
      console.log("\n5. open live feeds (GET /api/views/changes): database sessions held by N open feeds, and the time for one write to reach all of them");
      const w5 = [7, 9, 13, 14];
      console.log(row(["feeds", "sessions", "open ms", "write->all ms"], w5));
      const app = await startApp(db.connInfo, { pool: POOL, viewDelayMs: 0, wait: "hub" });
      const open: Array<{ readonly controller: AbortController; frames: number; lastFrameAt: number }> = [];
      const openFeed = async () => {
        const controller = new AbortController();
        const feed = { controller, frames: 0, lastFrameAt: 0 };
        const res = await fetch(`${app.baseUrl}/api/views/changes?views=course-seats-view`, { signal: controller.signal, headers: { Accept: "text/event-stream" } });
        const reader = res.body!.getReader();
        void (async () => {
          const decoder = new TextDecoder();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              feed.frames += (text.match(/data:/g) ?? []).length;
              feed.lastFrameAt = performance.now();
            }
          } catch {
            // aborted
          }
        })();
        open.push(feed);
      };
      for (const target of [0, 50, 200, 1000]) {
        const t0 = performance.now();
        while (open.length < target) await openFeed();
        const openMs = performance.now() - t0;
        while (open.some((f) => f.frames === 0)) await sleep(20);
        await sleep(300);
        const held = await sessions();
        let reach = NaN;
        if (target > 0) {
          const framesBefore = open.map((f) => f.frames);
          const t1 = performance.now();
          await post(app.baseUrl, "define_course", { courseId: `feed-${target}-${crypto.randomUUID().slice(0, 6)}`, capacity: 5 });
          const deadline = performance.now() + 15_000;
          while (open.some((f, i) => f.frames <= framesBefore[i]!) && performance.now() < deadline) await sleep(5);
          reach = Math.max(...open.map((f) => f.lastFrameAt)) - t1;
        }
        console.log(row([target, held, fmt(openMs, 0), fmt(reach, 0)], w5));
      }
      for (const f of open) f.controller.abort();
      await app.stop();
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
