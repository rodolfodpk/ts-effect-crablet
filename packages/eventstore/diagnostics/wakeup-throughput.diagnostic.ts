// DIAGNOSTIC EXPERIMENT (docs/adr/0021-wakeups-after-commit-and-coalesced.md), not a test: it measures, it does not assert. Real Postgres (Testcontainers, needs Docker).
// Run with:  node --test packages/eventstore/diagnostics/wakeup-throughput.diagnostic.ts   and read the `DIAG` lines.   SECONDS=20 CLIENTS=32 to change the run.
// The same workload through the real EventStore in each wake-up mode: CLIENTS concurrent fibers, each doing `withWakeups(withTransaction(append one event))` in a loop for SECONDS,
// with a distinct tag per event so no append waits on another's advisory lock. A listener is attached so notifications have a receiver, as in a running system.
// The modes alternate (inline, coalesced, inline, coalesced) so drift of the machine shows as a difference between runs of the same mode.
import { after, before, describe, it } from "node:test";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, makeEventStoreLayer, type EventStoreConfig } from "../src/EventStore.ts";
import * as AppendEvent from "../src/AppendEvent.ts";

const SECONDS = Number(process.env["SECONDS"] ?? 15);
const CLIENTS = Number(process.env["CLIENTS"] ?? 32);
let db: TestDb;
before(async () => { db = await startTestDb(); }, { timeout: 60_000 });
after(async () => { await db.stop(); });

const measure = async (label: string, config: EventStoreConfig) => {
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(makeEventStoreLayer(config), PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), maxConnections: CLIENTS + 4 })) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient, never>
  );
  const latencies: number[] = [];
  const end = Date.now() + SECONDS * 1000;
  await runtime.runPromise(Effect.gen(function* () {
    const store = yield* EventStore;
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.forEach(Array.from({ length: CLIENTS }, (_, c) => c), (c) => Effect.gen(function* () {
      for (let i = 0; Date.now() < end; i++) {
        const t0 = performance.now();
        yield* store.withWakeups(sql.withTransaction(store.append([AppendEvent.of("Deposited", "wallet_id", `${label}-${c}-${i}-${Math.random()}`, {})])));
        latencies.push(performance.now() - t0);
      }
    }) as Effect.Effect<void>, { concurrency: CLIENTS, discard: true });
  }) as Effect.Effect<void>);
  await runtime.dispose();
  latencies.sort((a, b) => a - b);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!.toFixed(1);
  console.log(`DIAG ${label}: ${(latencies.length / SECONDS).toFixed(0)} appends/s, p50 ${p(0.5)} ms, p95 ${p(0.95)} ms (${CLIENTS} clients, ${SECONDS} s)`);
};

describe("wake-up throughput by mode", () => {
  it("inline, coalesced (50 ms), inline, coalesced", { timeout: 600_000 }, async () => {
    await measure("inline #1", { wakeupMode: "inline" });
    await measure("coalesced-50ms #1", { wakeupMode: "coalesced", wakeupWindowMs: 50 });
    await measure("inline #2", { wakeupMode: "inline" });
    await measure("coalesced-50ms #2", { wakeupMode: "coalesced", wakeupWindowMs: 50 });
  });
});
