// DIAGNOSTIC EXPERIMENTS (docs/plans/reliability-and-scale-diagnostic.md), not tests: they measure, they do not assert. Real Postgres (Testcontainers, needs Docker),
// the real processor, leader election and listeners. Run with:  node --test packages/event-poller/diagnostics/leader-and-listener.diagnostic.ts
// and read the `DIAG` lines (add --test-name-pattern="D1|D1b|D2|D3" to pick one). D1: the leader's database session dies (does it stop? does the other instance take
// over? duplicates? does the cursor go backwards?). D1b: the leader process dies (how long until the follower takes over). D2: can the cursor be written backwards.
// D3: the crablet_events LISTEN connection is lost (how stale does a view get). The folder is outside the test globs, so CI does not run it.
import { after, before, describe, it } from "node:test";
import { performance } from "node:perf_hooks";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive, EVENTS_CHANNEL } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { tryAcquireGlobalLeader } from "@crablet/eventstore/Leader";
import { wakeupStream } from "@crablet/eventstore/Listen";
import { makeEventProcessor } from "../src/EventProcessor.ts";
import { makePostgresProgressTracker } from "../src/PostgresProgressTracker.ts";
import { makeSqlEventFetcher } from "../src/SqlEventFetcher.ts";
import { processorConfigOf } from "../src/ProcessorConfig.ts";
import * as EventSelection from "../src/EventSelection.ts";
import * as ProgressCursor from "../src/ProgressCursor.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | SqlClient.SqlClient | PgClient.PgClient, never>;
before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
  runtime = ManagedRuntime.make(Layer.provideMerge(EventStoreLive, pgLayer) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient | PgClient.PgClient, never>);
}, { timeout: 60_000 });
after(async () => { await runtime.dispose(); await db.stop(); });
const run = <A, E>(e: Effect.Effect<A, E, EventStore | SqlClient.SqlClient | PgClient.PgClient>) => runtime.runPromise(e);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sql = <A>(f: (s: SqlClient.SqlClient) => Effect.Effect<A, unknown, never>) => run(Effect.flatMap(SqlClient.SqlClient, f) as Effect.Effect<A, unknown, SqlClient.SqlClient>);

interface Call { readonly who: string; readonly at: number; readonly positions: ReadonlyArray<bigint> }

const start = (label: string, view: string, lockKey: bigint, calls: Array<Call>, o: { polling: number; retry: number; backoff?: boolean; backoffMaxSeconds?: number }) =>
  Effect.gen(function* () {
    const s = yield* SqlClient.SqlClient;
    const pg = yield* PgClient.PgClient;
    const progressTracker = yield* makePostgresProgressTracker<string>({ tableName: "crablet_view_progress", idColumn: "view_name" });
    const fetcher = yield* makeSqlEventFetcher<string>(EventSelection.of({ exactTags: new Map([["run_marker", view]]) }));
    const config = processorConfigOf(view, { pollingIntervalMs: o.polling, batchSize: 100, backoffEnabled: o.backoff ?? false, backoffThreshold: 3, backoffMultiplier: 2, backoffMaxSeconds: o.backoffMaxSeconds ?? 120, enabled: true });
    const handler = { handle: (_id: string, events: ReadonlyArray<{ position: bigint }>) => Effect.sync(() => { calls.push({ who: label, at: performance.now(), positions: events.map((e) => e.position) }); return events.length; }) };
    const handle = yield* makeEventProcessor({
      configs: [config], fetcher, handler: handler as never, progressTracker, selectionOf: () => EventSelection.empty(),
      instanceId: `${label}-${crypto.randomUUID().slice(0, 6)}`, acquireLeader: tryAcquireGlobalLeader(s, lockKey), wakeupStream: wakeupStream(pg, EVENTS_CHANNEL), leaderRetryIntervalMs: o.retry
    });
    yield* handle.service.start;
    return handle;
  });

const append = (view: string) => run(Effect.flatMap(EventStore, (es) => es.append([AppendEvent.of("DiagEvent", "run_marker", view, {})])));
const cursorOf = (view: string) => sql((s) => Effect.map(s.unsafe<{ p: string }>("SELECT last_position::text AS p FROM crablet_view_progress WHERE view_name = $1", [view]), (r) => (r[0] ? BigInt(r[0].p) : 0n)));
const pidHolding = (key: bigint) => sql((s) => Effect.map(s.unsafe<{ pid: number }>("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND ((classid::bigint << 32) | objid::bigint) = $1::bigint", [key.toString()]), (r) => r[0]?.pid ?? null));
const killPid = (pid: number) => sql((s) => Effect.asVoid(s.unsafe("SELECT pg_terminate_backend($1)", [pid])));

describe("DIAG", () => {
  it("D1: the leader's database session dies - a zombie, a failover, a regression?", { timeout: 180_000 }, async () => {
    const view = `diag-d1-${crypto.randomUUID().slice(0, 6)}`;
    const key = BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);
    const calls: Array<Call> = [];
    // the apps' real setting: leader retry every 30 s
    const [a, b] = await Promise.all([
      run(start("A", view, key, calls, { polling: 100, retry: 30_000 })),
      run(start("B", view, key, calls, { polling: 100, retry: 30_000 }))
    ]);
    let stopWriting = false;
    const writer = (async () => { while (!stopWriting) { await append(view); await sleep(50); } })();
    const cursors: Array<{ at: number; p: bigint }> = [];
    let sampling = true;
    const sampler = (async () => { while (sampling) { cursors.push({ at: performance.now(), p: await cursorOf(view) }); await sleep(20); } })();
    try {
      await sleep(3000);
      const leader = calls.find((c) => c.positions.length > 0)!.who;
      const pid = await pidHolding(key);
      const killedAt = performance.now();
      await killPid(pid!);
      await sleep(40_000); // longer than the 30 s retry interval
      stopWriting = true;
      await writer;
      await sleep(1500);
      sampling = false;
      await sampler;
      const after = calls.filter((c) => c.at >= killedAt);
      const by = (who: string) => after.filter((c) => c.who === who);
      const zombie = by(leader);
      const other = by(leader === "A" ? "B" : "A");
      const posBy = (cs: Call[]) => new Set(cs.flatMap((c) => c.positions.map(String)));
      const zombiePos = posBy(zombie), otherPos = posBy(other);
      const both = [...zombiePos].filter((p) => otherPos.has(p)).length;
      let regress = 0, worst = 0n;
      for (let i = 1; i < cursors.length; i++) if (cursors[i]!.p < cursors[i - 1]!.p) { regress++; const d = cursors[i - 1]!.p - cursors[i]!.p; if (d > worst) worst = d; }
      console.log(`DIAG D1 initial leader=${leader}; killed its database session at t=0 (the lock holder pid ${pid})`);
      console.log(`DIAG D1 the initial leader kept calling its handler after the kill: ${zombie.length} calls, last at +${zombie.length ? ((zombie[zombie.length - 1]!.at - killedAt) / 1000).toFixed(1) : "-"} s (the run ended at +40 s)`);
      console.log(`DIAG D1 the other instance first handled an event at +${other.length ? ((other[0]!.at - killedAt) / 1000).toFixed(1) : "never"} s (leader retry interval 30 s)`);
      console.log(`DIAG D1 events handled by BOTH instances after the kill: ${both} of ${new Set([...zombiePos, ...otherPos]).size}; handler calls overall after kill: ${after.length}`);
      console.log(`DIAG D1 progress cursor sampled every 20 ms: ${cursors.length} samples, ${regress} moved BACKWARDS (largest step back ${worst} positions)`);
      const gap = (() => { let g = 0; let prev: number | null = null; for (const c of after.sort((x, y) => x.at - y.at)) { if (prev !== null) g = Math.max(g, c.at - prev); prev = c.at; } return g; })();
      console.log(`DIAG D1 longest gap between any two handler calls after the kill: ${(gap / 1000).toFixed(1)} s`);
    } finally {
      stopWriting = true; sampling = false;
      await run(a.service.stop); await run(b.service.stop);
    }
  });

  it("D2: can the cursor be written backwards?", { timeout: 30_000 }, async () => {
    const view = `diag-d2-${crypto.randomUUID().slice(0, 6)}`;
    const tracker = await run(makePostgresProgressTracker<string>({ tableName: "crablet_view_progress", idColumn: "view_name" }));
    await run(tracker.autoRegister(view, "diag"));
    await run(tracker.updateCursor(view, ProgressCursor.of("900", 900n)));
    const high = await cursorOf(view);
    await run(tracker.updateCursor(view, ProgressCursor.of("100", 100n)));
    const low = await cursorOf(view);
    console.log(`DIAG D2 cursor after writing 900: ${high}; after then writing 100: ${low} -> ${low < high ? "REGRESSED (no guard)" : "held"}`);
  });

  it("D1b: the leader process dies (session gone, fibers gone): how long until the follower takes over?", { timeout: 180_000 }, async () => {
    const RETRY = 5_000;
    const gaps: number[] = [];
    for (let trial = 0; trial < 6; trial++) {
      const view = `diag-d1b-${trial}-${crypto.randomUUID().slice(0, 6)}`;
      const key = BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);
      const calls: Array<Call> = [];
      const a = await run(start("A", view, key, calls, { polling: 100, retry: RETRY }));
      await sleep(300);
      const b = await run(start("B", view, key, calls, { polling: 100, retry: RETRY }));
      let stop = false;
      const writer = (async () => { while (!stop) { await append(view); await sleep(50); } })();
      await sleep(900 + trial * 800); // the leader dies at a different phase of the follower's retry cycle each trial
      const pid = await pidHolding(key);
      const killedAt = performance.now();
      await killPid(pid!); // the server frees the lock
      await run(a.service.stop); // and the process is gone
      const before = calls.length;
      while (!calls.slice(before).some((c) => c.who === "B") && performance.now() - killedAt < 30_000) await sleep(20);
      const first = calls.slice(before).find((c) => c.who === "B");
      gaps.push(first ? first.at - killedAt : NaN);
      console.log(`DIAG D1b trial ${trial}: killed ${(900 + trial * 800) / 1000} s after the follower started; takeover after ${first ? ((first.at - killedAt) / 1000).toFixed(1) : 'never'} s`);
      stop = true; await writer; await run(b.service.stop);
    }
    console.log(`DIAG D1b follower takeover after the leader process died, retry interval ${RETRY / 1000} s: ${gaps.map((g) => (g / 1000).toFixed(1)).join(", ")} s  (mean ${(gaps.reduce((x, y) => x + y, 0) / gaps.length / 1000).toFixed(1)} s)`);
  });

  it("D3: the crablet_events LISTEN connection is lost - does the view still wake on a write?", { timeout: 240_000 }, async () => {
    const lagFor = async (killListener: boolean) => {
      const view = `diag-d3-${killListener ? "killed" : "healthy"}-${crypto.randomUUID().slice(0, 6)}`;
      const key = BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);
      const calls: Array<Call> = [];
      // a realistic app setting: poll every 1 s, back off after 3 empty polls (x2, up to 30 s)
      const h = await run(start("A", view, key, calls, { polling: 1000, retry: 30_000, backoff: true, backoffMaxSeconds: 30 }));
      try {
        await append(view); await sleep(1500);
        if (killListener) {
          const killed = await sql((s) => Effect.map(s.unsafe<{ pid: number }>("SELECT pg_terminate_backend(pid) AS ok, pid FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN%crablet_events%' AND pid <> pg_backend_pid()"), (r) => r.length));
          console.log(`DIAG D3 terminated ${killed} LISTEN crablet_events session(s)`);
        }
        await sleep(25_000); // idle: the poller backs off
        const before = calls.length;
        const t0 = performance.now();
        await append(view);
        while (calls.length === before && performance.now() - t0 < 60_000) await sleep(10);
        return calls.length === before ? NaN : calls[before]!.at - t0;
      } finally { await run(h.service.stop); }
    };
    const healthy = await lagFor(false);
    const killed = await lagFor(true);
    console.log(`DIAG D3 write -> handled, after 25 s idle (poller backed off): healthy listener ${healthy.toFixed(0)} ms; listener session killed ${Number.isNaN(killed) ? "never within 60 s" : killed.toFixed(0) + " ms"}`);
  });

  it("D3b: after the crablet_events LISTEN session is killed, is a new one ever opened?", { timeout: 120_000 }, async () => {
    const view = `diag-d3b-${crypto.randomUUID().slice(0, 6)}`;
    const key = BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);
    const calls: Array<Call> = [];
    const h = await run(start("A", view, key, calls, { polling: 500, retry: 2_000 }));
    const listeners = () => sql((s) => Effect.map(s.unsafe<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN%crablet_events%' AND pid <> pg_backend_pid()"), (r) => Number(r[0]!.n)));
    try {
      await sleep(1500);
      const before = await listeners();
      await sql((s) => Effect.asVoid(s.unsafe("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN%crablet_events%' AND pid <> pg_backend_pid()")));
      const samples: Array<string> = [];
      for (let i = 0; i < 6; i++) { await sleep(5_000); samples.push(`+${(i + 1) * 5}s:${await listeners()}`); }
      console.log(`DIAG D3b LISTEN crablet_events sessions: before the kill ${before}; after it ${samples.join("  ")}`);
    } finally { await run(h.service.stop); }
  });

  it("D4: a reserved connection whose session is killed - does its next query fail, or does it silently reconnect?", { timeout: 60_000 }, async () => {
    const key = BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`);
    const outcome = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const s = yield* SqlClient.SqlClient;
          const connection = yield* s.reserve;
          const pidBefore = (yield* connection.execute("SELECT pg_backend_pid() AS pid", [], undefined) as Effect.Effect<Array<{ pid: number }>>)[0]!.pid;
          yield* connection.execute("SELECT pg_try_advisory_lock($1)", [key.toString()], undefined);
          yield* Effect.promise(() => killPid(pidBefore));
          yield* Effect.sleep("300 millis");
          const results: string[] = [];
          for (let i = 0; i < 3; i++) {
            const r = yield* Effect.exit(connection.execute("SELECT pg_backend_pid() AS pid", [], undefined) as Effect.Effect<Array<{ pid: number }>>);
            results.push(r._tag === "Success" ? `OK on pid ${(r.value as Array<{ pid: number }>)[0]!.pid}` : "FAILED");
            yield* Effect.sleep("200 millis");
          }
          const holder = yield* Effect.promise(() => pidHolding(key));
          return { pidBefore, results, holder };
        })
      )
    );
    console.log(`DIAG D4 reserved session pid ${outcome.pidBefore} killed; three queries on the same connection afterwards: ${outcome.results.join(", ")}; advisory lock holder now: ${outcome.holder ?? "nobody"}`);
  });
});
