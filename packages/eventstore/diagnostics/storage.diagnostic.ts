// DIAGNOSTIC EXPERIMENTS (docs/adr/0019-storage-visibility-and-the-tag-table.md), not tests: they measure, they do not assert. Real Postgres (Testcontainers, needs Docker).
// Run with:  node --test packages/eventstore/diagnostics/storage.diagnostic.ts   and read the `DIAG` lines.   N=200000 node --test ... for a quicker, smaller run.
// It runs on the shipped schema (crablet_event_tag_keys). ADR-0019 measured and decided on the schema before it (a tag table with key, value, position and
// three indexes) with a third experiment, E9b, comparing that table with its alternatives; that schema is no longer in the migrations (ADR-0047), so E9b
// is gone, and its results are in the ADR.
// E9a: where the bytes of one event go, at N events shaped like the wallet's (95 % deposits with 5 tags, 5 % transfers with 7).
import { after, before, describe, it } from "node:test";
import { performance } from "node:perf_hooks";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "../src/EventStore.ts";
import * as AppendEvent from "../src/AppendEvent.ts";

const N = Number(process.env["N"] ?? 1_000_000);
const TAG_TABLE = "crablet_event_tag_keys";
const WALLETS = Math.max(1_000, Math.floor(N / 10));
let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | SqlClient.SqlClient, never>;
before(async () => {
  db = await startTestDb();
  runtime = ManagedRuntime.make(
    Layer.provideMerge(EventStoreLive, PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) })) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient, never>
  );
}, { timeout: 60_000 });
after(async () => { await runtime.dispose(); await db.stop(); });

const q = <A>(text: string, params: ReadonlyArray<unknown> = []) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A & object>(text, params as never)) as Effect.Effect<ReadonlyArray<A>, never, SqlClient.SqlClient>) as Promise<ReadonlyArray<A>>;
const mb = (bytes: number | string) => `${(Number(bytes) / 1_048_576).toFixed(1)} MiB`;
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]!;
const MONTHS = 12;

const deposit = (i: number) => {
  const wallet = `w${i % WALLETS}`;
  const stmt = `${wallet}-${2026}-${1 + (i % MONTHS)}`;
  const builder = AppendEvent.builder("DepositMade").tag("wallet_id", wallet).tag("deposit_id", `d${i}`).tag("year", "2026").tag("month", String(1 + (i % MONTHS))).tag("statement_id", stmt);
  // a RARE key: one event in 10,000 (0.01 %) carries an audit_id, which is what an index on the key is for
  if (i % 10_000 === 0 && i < 10_000_000) builder.tag("audit_id", `a${i}`);
  return builder
    .data({ depositId: `d${i}`, walletId: wallet, amount: 1 + (i % 500), newBalance: 1000 + (i % 9000), depositedAt: "2026-03-15T10:00:00.000Z", description: "salary payment" }).build();
};
const transfer = (i: number) => {
  const from = `w${i % WALLETS}`, to = `w${(i * 7 + 1) % WALLETS}`;
  return AppendEvent.builder("MoneyTransferred").tag("transfer_id", `t${i}`).tag("from_wallet_id", from).tag("to_wallet_id", to).tag("year", "2026").tag("month", String(1 + (i % MONTHS)))
    .tag("from_statement_id", `${from}-2026-${1 + (i % MONTHS)}`).tag("to_statement_id", `${to}-2026-${1 + (i % MONTHS)}`)
    .data({ transferId: `t${i}`, fromWalletId: from, toWalletId: to, amount: 1 + (i % 300), fromBalance: 900, toBalance: 1100, transferredAt: "2026-03-15T10:00:00.000Z", description: "gift" }).build();
};

describe("DIAG", () => {
  it("E9a: where the bytes of one event go", { timeout: 1_800_000 }, async () => {
    const t0 = performance.now();
    await runtime.runPromise(Effect.gen(function* () {
      const es = yield* EventStore;
      // MAX_APPEND_EVENTS (50) is the most one append takes.
      for (let start = 0; start < N; start += 50) {
        yield* es.append(Array.from({ length: Math.min(50, N - start) }, (_, k) => ((start + k) % 20 === 0 ? transfer(start + k) : deposit(start + k))));
      }
    }));
    const secs = (performance.now() - t0) / 1000;
    await q("VACUUM ANALYZE crablet_events"); await q(`VACUUM ANALYZE ${TAG_TABLE}`);
    console.log(`DIAG E9a appended ${N} events through the real append path in ${secs.toFixed(0)} s (${(N / secs).toFixed(0)} events/s, batches of 50)`);
    const sizes = await q<{ rel: string; kind: string; bytes: string }>(`
      SELECT c.relname AS rel, CASE WHEN c.relkind = 'i' THEN 'index' ELSE 'heap' END AS kind, pg_relation_size(c.oid)::text AS bytes
      FROM pg_class c
      WHERE c.relkind IN ('r', 'i') AND pg_relation_size(c.oid) > 65536
        AND (c.relname LIKE 'crablet\\_%' OR c.oid IN (SELECT i.indexrelid FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid WHERE t.relname LIKE 'crablet\\_%'))
      ORDER BY pg_relation_size(c.oid) DESC`);
    for (const s of sizes) console.log(`DIAG E9a   ${s.kind.padEnd(5)} ${s.rel.padEnd(52)} ${mb(s.bytes).padStart(10)}  ${(Number(s.bytes) / N).toFixed(0).padStart(4)} B/event`);
    const tagRows = Number((await q<{ n: string }>(`SELECT count(*) AS n FROM ${TAG_TABLE}`))[0]!.n);
    const tagTotal = Number((await q<{ b: string }>(`SELECT pg_total_relation_size('${TAG_TABLE}') AS b`))[0]!.b);
    const evTotal = Number((await q<{ b: string }>("SELECT pg_total_relation_size('crablet_events') AS b"))[0]!.b);
    const toast = Number((await q<{ b: string }>("SELECT COALESCE(pg_total_relation_size(reltoastrelid), 0) AS b FROM pg_class WHERE relname = 'crablet_events'"))[0]!.b);
    console.log(`DIAG E9a total ${mb(evTotal + tagTotal)} for ${N} events = ${((evTotal + tagTotal) / N).toFixed(0)} B/event; events table ${mb(evTotal)} (${(evTotal / N).toFixed(0)} B/event, toast ${mb(toast)}), tag table ${mb(tagTotal)} (${(tagTotal / N).toFixed(0)} B/event, ${tagRows} rows, ${(tagTotal / tagRows).toFixed(0)} B/tag row) = ${((100 * tagTotal) / (evTotal + tagTotal)).toFixed(0)} % of events+tags`);
  });

  it("E9c: what the tag rows cost on the write path (events per second through the real append path, with and without them)", { timeout: 1_800_000 }, async () => {
    const M = Math.min(N, 60_000);
    const rate = async (label: string, offset: number) => {
      const t0 = performance.now();
      await runtime.runPromise(Effect.gen(function* () {
        const es = yield* EventStore;
        for (let start = 0; start < M; start += 200) yield* es.append(Array.from({ length: 200 }, (_, k) => deposit(offset + start + k)));
      }));
      const secs = (performance.now() - t0) / 1000;
      console.log(`DIAG E9c ${label}: ${M} deposits (5 tags each) in ${secs.toFixed(1)} s = ${(M / secs).toFixed(0)} events/s`);
      return M / secs;
    };
    const withTags = await rate("with the tag rows (as built)", 10_000_000);
    const def = (await q<{ d: string }>("SELECT pg_get_functiondef('append_events_batch(text[], text[], jsonb[], timestamptz, uuid, bigint, bytea, jsonb[])'::regprocedure) AS d"))[0]!.d;
    const stripped = def.replace(/,\s*tagged AS \([\s\S]*?WHERE tag LIKE '%=%'\)/u, "");
    if (stripped === def) { console.log("DIAG E9c could not strip the tagged CTE from the function; skipping the comparison"); return; }
    await q(stripped);
    const without = await rate("without the tag rows (function altered in this scratch database)", 20_000_000);
    console.log(`DIAG E9c the tag rows cost ${(100 * (1 - withTags / without)).toFixed(0)} % of append throughput here (one connection, batches of 200; indicative, one run each)`);
  });
});
