// DIAGNOSTIC EXPERIMENTS (docs/adr/0019-storage-visibility-and-the-tag-table.md), not tests: they measure, they do not assert. Real Postgres (Testcontainers, needs Docker).
// Run with:  node --test packages/eventstore/diagnostics/storage.diagnostic.ts   and read the `DIAG` lines.   N=200000 node --test ... for a quicker, smaller run.
// By default it runs on the schema as it was BEFORE migration V11 (the tag table with key, value, position and three indexes), which is what ADR-0019 measured and
// decided about. SCHEMA=current runs E9a and E9c on the shipped schema (V11: crablet_event_tag_keys) to measure the result of the change.
// E9a: where the bytes of one event go, at N events shaped like the wallet's (95 % deposits with 5 tags, 5 % transfers with 7).
// E9b: what the tag table would cost, and what the poller's key-presence selections would cost, under alternatives to it.
import { after, before, describe, it } from "node:test";
import { performance } from "node:perf_hooks";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { migrationFiles, startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "../src/EventStore.ts";
import * as AppendEvent from "../src/AppendEvent.ts";

const N = Number(process.env["N"] ?? 1_000_000);
const CURRENT = process.env["SCHEMA"] === "current";
const TAG_TABLE = CURRENT ? "crablet_event_tag_keys" : "crablet_event_tags";
const WALLETS = Math.max(1_000, Math.floor(N / 10));
let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | SqlClient.SqlClient, never>;
before(async () => {
  db = await startTestDb(CURRENT ? {} : { migrations: migrationFiles.slice(0, -1) });
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
      for (let start = 0; start < N; start += 200) {
        yield* es.append(Array.from({ length: Math.min(200, N - start) }, (_, k) => ((start + k) % 20 === 0 ? transfer(start + k) : deposit(start + k))));
      }
    }));
    const secs = (performance.now() - t0) / 1000;
    await q("VACUUM ANALYZE crablet_events"); await q(`VACUUM ANALYZE ${TAG_TABLE}`);
    console.log(`DIAG E9a appended ${N} events through the real append path in ${secs.toFixed(0)} s (${(N / secs).toFixed(0)} events/s, batches of 200)`);
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

  it("E9b: the tag table against its alternatives, for the poller's key-presence selections (V10 schema only)", { timeout: 1_800_000, skip: CURRENT }, async () => {
    const sec = (text: string) => console.log(`DIAG E9b ${text}`);
    // alternatives, built from the data that is there
    await q("CREATE TABLE tag_slim AS SELECT key, position FROM crablet_event_tags");
    await q("ALTER TABLE tag_slim ADD PRIMARY KEY (key, position)");
    await q("CREATE TABLE ev_keys AS SELECT e.*, ARRAY(SELECT DISTINCT split_part(t, '=', 1) FROM unnest(e.tags) t) AS tag_keys FROM crablet_events e");
    await q("ALTER TABLE ev_keys ADD PRIMARY KEY (position)");
    await q("CREATE INDEX ev_keys_xp ON ev_keys (transaction_id, position)");
    await q("CREATE INDEX ev_keys_gin ON ev_keys USING GIN (tag_keys)");
    await q("VACUUM ANALYZE tag_slim"); await q("VACUUM ANALYZE ev_keys");
    const size = async (name: string) => Number((await q<{ b: string }>(`SELECT pg_total_relation_size('${name}') AS b`))[0]!.b);
    const cur = await size("crablet_event_tags"), slim = await size("tag_slim");
    const gin = Number((await q<{ b: string }>("SELECT pg_relation_size('ev_keys_gin') AS b"))[0]!.b);
    const colBytes = Number((await q<{ b: string }>("SELECT sum(pg_column_size(tag_keys)) AS b FROM ev_keys"))[0]!.b);
    sec(`cost of finding events by tag KEY: the current tag table ${mb(cur)} (${(cur / N).toFixed(0)} B/event); a slim tag table (key, position), primary key only ${mb(slim)} (${((100 * slim) / cur).toFixed(0)} % of current); a tag_keys array column on the events + a GIN index on it ${mb(colBytes + gin)} (column ${mb(colBytes)} + index ${mb(gin)}, ${((colBytes + gin) / N).toFixed(0)} B/event, ${((100 * (colBytes + gin)) / cur).toFixed(0)} % of current)`);

    const cursorRow = (await q<{ x: string; p: string }>(`SELECT transaction_id::text AS x, position::text AS p FROM crablet_events ORDER BY transaction_id, position OFFSET ${N - 5_000} LIMIT 1`))[0]!;
    const zero = { x: "0", p: "0" };
    const variants: ReadonlyArray<{ name: string; sql: (keysParam: string) => string }> = [
      { name: "current tag table (EXISTS on key)", sql: (k) => `SELECT e.type, e.tags, e.data, e.position FROM crablet_events e WHERE (e.transaction_id, e.position) > ($1::xid8, $2::bigint) AND e.transaction_id < pg_snapshot_xmin(pg_current_snapshot()) AND EXISTS (SELECT 1 FROM crablet_event_tags t WHERE t.position = e.position AND t.key = ANY(${k})) ORDER BY e.transaction_id, e.position LIMIT 100` },
      { name: "slim tag table (key, position)         ", sql: (k) => `SELECT e.type, e.tags, e.data, e.position FROM crablet_events e WHERE (e.transaction_id, e.position) > ($1::xid8, $2::bigint) AND e.transaction_id < pg_snapshot_xmin(pg_current_snapshot()) AND EXISTS (SELECT 1 FROM tag_slim t WHERE t.position = e.position AND t.key = ANY(${k})) ORDER BY e.transaction_id, e.position LIMIT 100` },
      { name: "tag_keys column + GIN on the events    ", sql: (k) => `SELECT e.type, e.tags, e.data, e.position FROM ev_keys e WHERE (e.transaction_id, e.position) > ($1::xid8, $2::bigint) AND e.transaction_id < pg_snapshot_xmin(pg_current_snapshot()) AND e.tag_keys && ${k} ORDER BY e.transaction_id, e.position LIMIT 100` },
      { name: "no helper: split the tags of each row  ", sql: (k) => `SELECT e.type, e.tags, e.data, e.position FROM crablet_events e WHERE (e.transaction_id, e.position) > ($1::xid8, $2::bigint) AND e.transaction_id < pg_snapshot_xmin(pg_current_snapshot()) AND EXISTS (SELECT 1 FROM unnest(e.tags) u WHERE split_part(u, '=', 1) = ANY(${k})) ORDER BY e.transaction_id, e.position LIMIT 100` }
    ];
    const cases: ReadonlyArray<{ label: string; keys: string[]; from: { x: string; p: string } }> = [
      { label: "tail fetch, key on every event (wallet_id)", keys: ["wallet_id"], from: cursorRow },
      { label: "tail fetch, key on 5 % of events (transfer_id)", keys: ["transfer_id"], from: cursorRow },
      { label: "catch-up from the start, key on 5 % (transfer_id)", keys: ["transfer_id"], from: zero },
      { label: "tail fetch, RARE key (0.01 %: audit_id)", keys: ["audit_id"], from: cursorRow },
      { label: "catch-up from the start, RARE key (0.01 %: audit_id)", keys: ["audit_id"], from: zero }
    ];
    for (const c of cases) {
      sec(`${c.label}: batch of 100, p50 / p95 of 15 runs`);
      for (const v of variants) {
        const xs: number[] = [];
        await q(v.sql("$3::text[]"), [c.from.x, c.from.p, c.keys]);
        for (let i = 0; i < 15; i++) { const t0 = performance.now(); await q(v.sql("$3::text[]"), [c.from.x, c.from.p, c.keys]); xs.push(performance.now() - t0); }
        sec(`   ${v.name} ${pct(xs, 50).toFixed(1).padStart(8)} ms / ${pct(xs, 95).toFixed(1).padStart(8)} ms`);
      }
    }
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
    const def = (await q<{ d: string }>("SELECT pg_get_functiondef('append_events_batch(text[], text[], jsonb[], timestamptz, uuid, bigint)'::regprocedure) AS d"))[0]!.d;
    const stripped = def.replace(/,\s*tagged AS \([\s\S]*?WHERE tag LIKE '%=%'\)/u, "");
    if (stripped === def) { console.log("DIAG E9c could not strip the tagged CTE from the function; skipping the comparison"); return; }
    await q(stripped);
    const without = await rate("without the tag rows (function altered in this scratch database)", 20_000_000);
    console.log(`DIAG E9c the tag rows cost ${(100 * (1 - withTags / without)).toFixed(0)} % of append throughput here (one connection, batches of 200; indicative, one run each)`);
  });
});
