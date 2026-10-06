// DIAGNOSTIC EXPERIMENTS (docs/plans/reliability-and-scale-diagnostic.md), not tests: they measure, they do not assert. Real Postgres (Testcontainers, needs Docker).
// Run with:  node --test packages/commands/diagnostics/boundary-and-storage.diagnostic.ts   and read the `DIAG` lines.
// E5: command latency against the number of events in its boundary. E7: what a command does when an event in its boundary no longer matches its schema.
// E8: what an event costs on disk (events heap and indexes, the tag table). The folder is outside the test globs, so CI does not run it.
import { after, before, describe, it } from "node:test";
import { performance } from "node:perf_hooks";
import { Effect, Exit, ManagedRuntime, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql";
import { EventStore } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import * as LogPosition from "@crablet/eventstore/LogPosition";
import { startTestDb, type TestDb } from "@crablet/test-support";
import * as Crablet from "../src/Crablet.ts";
import { CommandExecutor } from "../src/CommandExecutor.ts";
import { defineCommand, emit } from "../src/Command.ts";
import { defineEvent } from "../src/Event.ts";
import { defineModel } from "../src/Model.ts";

const Ticked = defineEvent("Ticked", { schema: Schema.Struct({ entityId: Schema.String }), tags: (d) => ({ entity_id: d.entityId }) });
const CountModel = defineModel({ by: "entity_id", initial: () => ({ n: 0 }) }).on(Ticked, (s) => ({ n: s.n + 1 }));
const Tick = defineCommand({ name: "tick", errors: [], input: Schema.Struct({ entityId: Schema.String }), model: (c) => CountModel.of({ id: c.entityId }), decide: (_m, c) => emit(Ticked(c)) });

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<any, any>;
before(async () => {
  db = await startTestDb();
  runtime = ManagedRuntime.make(Crablet.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) }));
}, { timeout: 60_000 });
after(async () => { await runtime.dispose(); await db.stop(); });

const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]!;
const insertRaw = (entity: string, n: number, data: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("INSERT INTO crablet_events (type, tags, data, transaction_id) SELECT 'Ticked', ARRAY['entity_id=' || $1], $2::jsonb, pg_current_xact_id() FROM generate_series(1, $3)", [entity, data, n])));
const tick = (entity: string) => runtime.runPromise(Effect.flatMap(CommandExecutor, (ex) => ex.run(Tick, { entityId: entity })));
const plainAppend = (entity: string) => runtime.runPromise(Effect.flatMap(EventStore, (es) => es.append([AppendEvent.of("Ticked", "entity_id", entity, { entityId: entity })])));

describe("DIAG", () => {
  it("E5: command latency against the number of events in its boundary", { timeout: 600_000 }, async () => {
    let have = 0;
    for (const n of [0, 100, 1_000, 10_000, 100_000, 500_000]) {
      if (n > have) { await insertRaw("big", n - have, '{"entityId":"big"}'); have = n; }
      await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("ANALYZE crablet_events")));
      const withModel: number[] = [], appendOnly: number[] = [];
      for (let i = 0; i < 25; i++) { const t0 = performance.now(); await tick("big"); withModel.push(performance.now() - t0); }
      for (let i = 0; i < 25; i++) { const t0 = performance.now(); await plainAppend("big"); appendOnly.push(performance.now() - t0); }
      console.log(`DIAG E5 boundary of ${String(n).padStart(7)} events: command p50 ${pct(withModel, 50).toFixed(1).padStart(7)} ms  p95 ${pct(withModel, 95).toFixed(1).padStart(7)} ms   | unconditional append to the same tag p50 ${pct(appendOnly, 50).toFixed(1)} ms`);
    }
  });

  it("E5b: where the time of a command goes with 100,000 events in its boundary", { timeout: 600_000 }, async () => {
    const N = 100_000;
    await insertRaw("prof", N, '{"entityId":"prof"}');
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("ANALYZE crablet_events")));
    const reps = 15;
    const time = async (f: () => Promise<unknown>) => { const xs: number[] = []; await f(); for (let i = 0; i < reps; i++) { const t0 = performance.now(); await f(); xs.push(performance.now() - t0); } return pct(xs, 50); };
    const model = CountModel.of({ id: "prof" });
    const noop = { eventTypes: [] as ReadonlyArray<string>, initialState: 0, transition: (s: number) => s };
    const run = <A>(e: Effect.Effect<A, any, any>) => runtime.runPromise(e as Effect.Effect<A, never, never>);
    // 1. fetch + driver + row parsing, nothing applied to the rows
    const fetchOnly = await time(() => run(Effect.flatMap(EventStore, (es) => es.project(model.query, LogPosition.zero(), [noop]))));
    // 2. the same plus decoding every payload with the schema and folding (what a command does to load its state)
    const load = await time(() => run(Effect.flatMap(EventStore, (es) => model.load(es))));
    // 3. server side only: the database's own execution time for the read (EXPLAIN ANALYZE), and the rows it returns
    const explain = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<{ "QUERY PLAN": ReadonlyArray<{ "Execution Time": number; Plan: { "Node Type": string; "Actual Rows": number } }> }>(
      "EXPLAIN (ANALYZE, FORMAT JSON) SELECT type, tags, data, transaction_id::text AS transaction_id, position, occurred_at, correlation_id, causation_id, (transaction_id < pg_snapshot_xmin(pg_current_snapshot())) AS settled FROM crablet_events WHERE (tags @> ARRAY['entity_id=prof']::text[]) ORDER BY crablet_events.transaction_id, position ASC")));
    const plan = explain[0]!["QUERY PLAN"][0]!;
    // 4. the whole command, and 5. the append alone, with the same condition but nothing to load (a boundary at the end of the log)
    const command = await time(() => tick("prof"));
    // 6. decode + fold in memory on already-fetched rows: what the CPU part costs without the database or the driver
    const rows = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<{ data: unknown }>("SELECT data FROM crablet_events WHERE tags @> ARRAY['entity_id=prof']::text[] ORDER BY transaction_id, position")));
    const decode = Schema.decodeUnknownSync(Schema.Struct({ entityId: Schema.String }));
    const t0 = performance.now(); let n = 0; for (const r of rows) { decode(r.data); n++; } const decodeMs = performance.now() - t0;
    console.log(`DIAG E5b ${N} events in the boundary (p50 of ${reps} runs): command ${command.toFixed(0)} ms | load (fetch+parse+decode+fold) ${load.toFixed(0)} ms | fetch+parse only ${fetchOnly.toFixed(0)} ms | database execution of the read ${plan["Execution Time"].toFixed(0)} ms (${plan.Plan["Node Type"]}, ${plan.Plan["Actual Rows"]} rows)`);
    console.log(`DIAG E5b so: decode+fold ~${(load - fetchOnly).toFixed(0)} ms, append and the rest of the command ~${(command - load).toFixed(0)} ms, driver+network+row objects ~${(fetchOnly - plan["Execution Time"]).toFixed(0)} ms; schema decode alone over ${n} payloads: ${decodeMs.toFixed(0)} ms`);
  });

  it("E5c: reading only the events after a cursor (what a snapshot would leave to read) in a boundary of 100,000, with and without 400,000 other events in the log", { timeout: 600_000 }, async () => {
    const reps = 15;
    const run = <A>(e: Effect.Effect<A, any, any>) => runtime.runPromise(e as Effect.Effect<A, never, never>);
    const model = CountModel.of({ id: "tail" });
    const noop = { eventTypes: [] as ReadonlyArray<string>, initialState: 0, transition: (s: number) => s };
    const measure = async (label: string) => {
      await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("ANALYZE crablet_events")));
      const cursorRow = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<{ p: string; x: string }>("SELECT position::text AS p, transaction_id::text AS x FROM crablet_events WHERE tags @> ARRAY['entity_id=tail']::text[] ORDER BY transaction_id, position OFFSET 99990 LIMIT 1")));
      const cursor = LogPosition.of(BigInt(cursorRow[0]!.p), new Date(), cursorRow[0]!.x);
      const xs: number[] = [];
      const go = () => run(Effect.flatMap(EventStore, (es) => es.project(model.query, cursor, [noop])));
      await go();
      for (let i = 0; i < reps; i++) { const t0 = performance.now(); await go(); xs.push(performance.now() - t0); }
      const plan = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<{ "QUERY PLAN": ReadonlyArray<{ "Execution Time": number; Plan: any }> }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) SELECT type, tags, data, transaction_id::text AS transaction_id, position FROM crablet_events WHERE (transaction_id, position) > ('${cursorRow[0]!.x}'::xid8, ${cursorRow[0]!.p}::bigint) AND (tags @> ARRAY['entity_id=tail']::text[]) ORDER BY crablet_events.transaction_id, position ASC`)));
      const root = plan[0]!["QUERY PLAN"][0]!;
      const nodes: string[] = []; const walk = (n: any) => { nodes.push(`${n["Node Type"]}${n["Index Name"] ? ` ${n["Index Name"]}` : ""}`); (n.Plans ?? []).forEach(walk); }; walk(root.Plan);
      console.log(`DIAG E5c ${label}: reading the last 10 of 100,000 events through the command's read path: p50 ${pct(xs, 50).toFixed(1)} ms, p95 ${pct(xs, 95).toFixed(1)} ms | database execution ${root["Execution Time"].toFixed(1)} ms via ${nodes.join(" > ")}`);
    };
    await insertRaw("tail", 100_000, '{"entityId":"tail"}');
    await measure("log = this entity only (plus earlier experiments' rows)");
    await insertRaw("noise", 400_000, '{"entityId":"noise"}');
    await measure("plus 400,000 events of other entities written after it");
  });

  it("E5d: a transfer (a model over TWO accounts, `all`) when one of them has 100,000 events", { timeout: 600_000 }, async () => {
    const { Transfer, AccountOpened } = await import("../test/support/transfer.ts");
    const run = <A>(e: Effect.Effect<A, any, any>) => runtime.runPromise(e as Effect.Effect<A, never, never>);
    const big = `big-${crypto.randomUUID().slice(0, 6)}`, small = `small-${crypto.randomUUID().slice(0, 6)}`;
    await run(Effect.flatMap(EventStore, (es) => es.append([AccountOpened({ accountId: big, balance: 1_000_000_000 }), AccountOpened({ accountId: small, balance: 0 })])));
    // 100,000 deposits on `big`, written raw like the other experiments (the tag the model reads is account_id)
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("INSERT INTO crablet_events (type, tags, data, transaction_id) SELECT 'Deposited', ARRAY['account_id=' || $1], jsonb_build_object('accountId', $1::text, 'amount', 1), pg_current_xact_id() FROM generate_series(1, 100000)", [big])));
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("ANALYZE crablet_events")));
    const xs: number[] = [];
    const go = () => run(Effect.flatMap(CommandExecutor, (ex) => ex.run(Transfer, { transferId: crypto.randomUUID(), from: big, to: small, amount: 1 })));
    await go();
    for (let i = 0; i < 15; i++) { const t0 = performance.now(); await go(); xs.push(performance.now() - t0); }
    console.log(`DIAG E5d transfer between an account with 100,000 events and an empty one: p50 ${pct(xs, 50).toFixed(0)} ms, p95 ${pct(xs, 95).toFixed(0)} ms`);
  });

  it("E5e: the same command with a snapshot on its model (ADR-0018), 100,000 and 500,000 events in the boundary, with other entities' events after them", { timeout: 900_000 }, async () => {
    const SnapModel = defineModel({ by: "entity_id", initial: () => ({ n: 0 }) }).on(Ticked, (s) => ({ n: s.n + 1 })).snapshot({ name: "ticker", version: 1, schema: Schema.Struct({ n: Schema.Number }) });
    const TickSnap = defineCommand({ name: "tick_snap", errors: [], input: Schema.Struct({ entityId: Schema.String }), model: (c) => SnapModel.of({ id: c.entityId }), decide: (_m, c) => emit(Ticked(c)) });
    const tickSnap = (entity: string) => runtime.runPromise(Effect.flatMap(CommandExecutor, (ex) => ex.run(TickSnap, { entityId: entity })));
    const entity = "e5e";
    let have = 0;
    for (const n of [100_000, 500_000]) {
      await insertRaw(entity, n - have, '{"entityId":"e5e"}'); have = n;
      await insertRaw("e5e-noise", 200_000, '{"entityId":"e5e-noise"}'); // other entities' events written AFTER: the planner then walks the tags index
      await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("ANALYZE crablet_events")));
      const plain: number[] = [], warm: number[] = [];
      for (let i = 0; i < 15; i++) { const t0 = performance.now(); await tick(entity); plain.push(performance.now() - t0); }
      const t0 = performance.now(); await tickSnap(entity); const cold = performance.now() - t0; // folds everything and leaves the snapshot
      for (let i = 0; i < 25; i++) { const t1 = performance.now(); await tickSnap(entity); warm.push(performance.now() - t1); }
      // the realistic case: the log keeps growing with OTHER entities' events after the snapshot was taken, so the tail read has to filter them out
      await insertRaw("e5e-noise-after", 200_000, '{"entityId":"e5e-noise-after"}');
      await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("ANALYZE crablet_events")));
      const afterNoise: number[] = [];
      for (let i = 0; i < 25; i++) { const t1 = performance.now(); await tickSnap(entity); afterNoise.push(performance.now() - t1); }
      console.log(`DIAG E5e boundary of ${String(n).padStart(7)} events: command without snapshot p50 ${pct(plain, 50).toFixed(0)} ms | with snapshot: first (full fold + write) ${cold.toFixed(0)} ms, then p50 ${pct(warm, 50).toFixed(1)} ms p95 ${pct(warm, 95).toFixed(1)} ms | after 200,000 OTHER events were written following the snapshot: p50 ${pct(afterNoise, 50).toFixed(1)} ms p95 ${pct(afterNoise, 95).toFixed(1)} ms`);
    }
  });

  it("E7: an event whose stored payload no longer matches its schema is in a boundary", { timeout: 60_000 }, async () => {
    await insertRaw("drift", 3, '{"entityId":"drift"}'); // good
    await insertRaw("drift", 1, '{"entity":"drift","v":1}'); // an older shape: the field was renamed
    const exit = await runtime.runPromise(Effect.exit(Effect.flatMap(CommandExecutor, (ex) => ex.run(Tick, { entityId: "drift" }))));
    const text = Exit.isSuccess(exit) ? "SUCCEEDED (the event was skipped or accepted)" : JSON.stringify(exit.cause, (_k, v) => (typeof v === "bigint" ? String(v) : v)).slice(0, 300);
    console.log(`DIAG E7 running a command over a boundary that contains one event in an older payload shape: ${Exit.isSuccess(exit) ? "SUCCEEDED" : "FAILED"} :: ${text}`);
    // and it stays failed: every later command on that boundary
    const again = await runtime.runPromise(Effect.exit(Effect.flatMap(CommandExecutor, (ex) => ex.run(Tick, { entityId: "drift" }))));
    console.log(`DIAG E7 and again: ${Exit.isSuccess(again) ? "SUCCEEDED" : "FAILED"}`);
  });

  it("E8: what an event costs on disk (real appends, with their tag rows and indexes)", { timeout: 600_000 }, async () => {
    const TOTAL = 50_000, BATCH = 100;
    const t0 = performance.now();
    for (let b = 0; b < TOTAL / BATCH; b++) {
      await runtime.runPromise(Effect.flatMap(EventStore, (es) =>
        es.append(Array.from({ length: BATCH }, (_, i) => AppendEvent.of("Ticked", "entity_id", `e-${(b * BATCH + i) % 2000}`, { entityId: `e-${(b * BATCH + i) % 2000}`, note: "x".repeat(40) })))
      ));
    }
    const seconds = (performance.now() - t0) / 1000;
    const rows = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<{ name: string; bytes: string }>(`
      SELECT 'events heap' AS name, pg_relation_size('crablet_events')::text AS bytes
      UNION ALL SELECT 'events indexes', pg_indexes_size('crablet_events')::text
      UNION ALL SELECT 'event_tags (heap+indexes)', pg_total_relation_size('crablet_event_tags')::text`)));
    const total = rows.reduce((a, r) => a + Number(r.bytes), 0);
    console.log(`DIAG E8 ${TOTAL} events appended in ${seconds.toFixed(1)} s (${(TOTAL / seconds).toFixed(0)} events/s, batches of ${BATCH}, one connection)`);
    for (const r of rows) console.log(`DIAG E8   ${r.name.padEnd(28)} ${(Number(r.bytes) / TOTAL).toFixed(0)} bytes/event`);
    console.log(`DIAG E8   total ${(total / TOTAL).toFixed(0)} bytes/event -> 100 million events = ${(total / TOTAL * 1e8 / 1e9).toFixed(0)} GB, 1 billion = ${(total / TOTAL * 1e9 / 1e9).toFixed(0)} GB`);
  });
});
