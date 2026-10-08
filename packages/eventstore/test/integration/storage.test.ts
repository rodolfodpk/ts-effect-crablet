// Runs under Node (Testcontainers). The storage report and its gauges against a real database (ADR-0019).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Fiber, Layer, Metric, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import * as StorageMetrics from "@crablet/metrics-otel/StorageMetrics";
import { EventStore, EventStoreLive } from "../../src/EventStore.ts";
import * as AppendEvent from "../../src/AppendEvent.ts";
import { formatStorageReport, monitorStorage, recordStorage, storageReport } from "../../src/Storage.ts";

let db: TestDb;
let layer: Layer.Layer<EventStore | SqlClient.SqlClient, never>;
before(async () => {
  db = await startTestDb();
  layer = Layer.provideMerge(
    EventStoreLive,
    PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) })
  ) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient, never>;
}, { timeout: 60_000 });
after(async () => { await db.stop(); });
const run = <A, E>(e: Effect.Effect<A, E, EventStore | SqlClient.SqlClient>) => Effect.runPromise(Effect.provide(e, layer) as Effect.Effect<A, E, never>);
const gauge = (name: typeof StorageMetrics.tableBytes, attributes: Record<string, string>) => Effect.map(Metric.value(Metric.withAttributes(name, attributes)), (s) => (s as unknown as { value: number }).value);

describe("storageReport", () => {
  it("an empty log: every table is listed, there are no events, and no cost per event", async () => {
    const r = await run(storageReport());
    const names = r.tables.map((t) => t.table);
    for (const expected of ["crablet_events", "crablet_event_tag_keys", "crablet_commands", "crablet_model_snapshots", "crablet_view_progress", "crablet_outbox_topic_progress"]) assert.ok(names.includes(expected), `${expected} in ${names}`);
    assert.strictEqual(r.events, 0);
    assert.strictEqual(r.bytesPerEvent, null);
    assert.ok(formatStorageReport(r).includes("events: none"));
  });

  it("with events: rows, bytes split into heap/indexes/toast, the cost per event, and an exact count on request", { timeout: 60_000 }, async () => {
    const r = await run(Effect.gen(function* () {
      const es = yield* EventStore;
      for (let batch = 0; batch < 30; batch++) {
        yield* es.append(Array.from({ length: 100 }, (_, i) => AppendEvent.of("Ticked", "entity_id", `e${batch}-${i}`, { n: i, text: "x".repeat(40) })));
      }
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("ANALYZE crablet_events");
      yield* sql.unsafe("ANALYZE crablet_event_tag_keys");
      return { estimated: yield* storageReport(), exact: yield* storageReport({ exact: true }) };
    }));
    const events = r.estimated.tables.find((t) => t.table === "crablet_events")!;
    const tags = r.estimated.tables.find((t) => t.table === "crablet_event_tag_keys")!;
    assert.strictEqual(r.exact.events, 3_000);
    assert.ok(Math.abs(events.rows - 3_000) <= 150, `estimated rows ${events.rows}`);
    assert.ok(Math.abs(tags.rows - 3_000) <= 150, `one tag per event: ${tags.rows}`);
    for (const t of [events, tags]) {
      assert.ok(t.heapBytes > 0 && t.indexBytes > 0, `${t.table} has a heap and indexes`);
      assert.ok(t.totalBytes >= t.heapBytes + t.indexBytes, `${t.table}: the total includes heap and indexes`);
    }
    assert.ok(r.estimated.bytesPerEvent! > 100 && r.estimated.bytesPerEvent! < 5_000, `bytes per event ${r.estimated.bytesPerEvent}`);
    assert.strictEqual(r.estimated.tables[0]!.totalBytes >= r.estimated.tables[1]!.totalBytes, true, "largest first");
    assert.ok(formatStorageReport(r.estimated).includes("bytes per event"));
  });

  it("recordStorage sets the gauges, and monitorStorage keeps them current until interrupted", { timeout: 60_000 }, async () => {
    const r = await run(Effect.gen(function* () {
      const report = yield* storageReport();
      yield* recordStorage(report);
      const events = report.tables.find((t) => t.table === "crablet_events")!;
      const recorded = { total: yield* gauge(StorageMetrics.tableBytes, { table: "crablet_events", part: "total" }), rows: yield* gauge(StorageMetrics.tableRows, { table: "crablet_events" }) };
      // the monitor refreshes after more events arrive
      const es = yield* EventStore;
      yield* es.append(Array.from({ length: 100 }, (_, i) => AppendEvent.of("Ticked", "entity_id", `m${i}`, { n: i })));
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("ANALYZE crablet_events");
      const fiber = yield* Effect.forkChild(monitorStorage({ every: "50 millis" }));
      yield* Effect.sleep("400 millis");
      const refreshed = yield* gauge(StorageMetrics.tableRows, { table: "crablet_events" });
      yield* Fiber.interrupt(fiber);
      return { events, recorded, refreshed, perEvent: yield* Effect.map(Metric.value(StorageMetrics.bytesPerEvent), (s) => (s as unknown as { value: number }).value) };
    }));
    assert.strictEqual(r.recorded.total, r.events.totalBytes);
    assert.strictEqual(r.recorded.rows, r.events.rows);
    assert.ok(r.refreshed > r.recorded.rows, `the monitor saw the new events: ${r.recorded.rows} -> ${r.refreshed}`);
    assert.ok(r.perEvent > 100);
  });
});
