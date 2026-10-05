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
