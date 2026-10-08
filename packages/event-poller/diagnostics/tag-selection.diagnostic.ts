// DIAGNOSTIC EXPERIMENTS (docs/adr/0019-storage-visibility-and-the-tag-table.md), not tests: they measure, they do not assert. Real Postgres (Testcontainers, needs Docker).
// Run with:  node --test packages/event-poller/diagnostics/tag-selection.diagnostic.ts   and read the `DIAG` lines.   N=200000 for a quicker, smaller run.
// Runs on the shipped schema (V11): "table" below is the slim crablet_event_tag_keys (key, position). (ADR-0019 first measured these against the pre-V11 tag table, then
// against a slim copy of it by swapping the table name; the numbers are in the ADR.)
// E9d: the poller's REAL queries (buildEventSelectionQuery / buildPendingSelectionQuery, through makeSqlEventFetcher / hasPendingSelectedEvents) with the wallet's
//      real selections, answering tag-key presence from the tag table ("table") or from the events' own tags ("scan").
// E9e: five pollers (four views and an outbox topic) and a writer at once, as built (tag table, tag rows written) against the alternative (scan, no tag rows).
import { after, before, describe, it } from "node:test";
import { performance } from "node:perf_hooks";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { hasPendingSelectedEvents, makeSqlEventFetcher } from "../src/SqlEventFetcher.ts";
import * as EventSelection from "../src/EventSelection.ts";
import * as ProgressCursorNS from "../src/ProgressCursor.ts";
import { buildEventSelectionQuery, buildPendingSelectionQuery, type TagKeyStrategy } from "../src/internal/sql.ts";

const N = Number(process.env["N"] ?? 1_000_000);
const WALLETS = Math.max(1_000, Math.floor(N / 10));
let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | SqlClient.SqlClient, never>;
before(async () => {
  db = await startTestDb();
  runtime = ManagedRuntime.make(
    Layer.provideMerge(EventStoreLive, PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), maxConnections: 12 })) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient, never>
  );
}, { timeout: 60_000 });
after(async () => { await runtime.dispose(); await db.stop(); });

const q = <A>(text: string, params: ReadonlyArray<unknown> = []) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A & object>(text, params as never)) as Effect.Effect<ReadonlyArray<A>, never, SqlClient.SqlClient>) as Promise<ReadonlyArray<A>>;
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]!;
const line = (text: string) => console.log(`DIAG ${text}`);
const MONTHS = 12;

// the same event shapes as storage.diagnostic.ts (95 % deposits with 5 tags, 5 % transfers with 7; a rare audit_id on 0.01 %)
const deposit = (i: number) => {
  const wallet = `w${i % WALLETS}`;
  const b = AppendEvent.builder("DepositMade").tag("wallet_id", wallet).tag("deposit_id", `d${i}`).tag("year", "2026").tag("month", String(1 + (i % MONTHS))).tag("statement_id", `${wallet}-2026-${1 + (i % MONTHS)}`);
  if (i % 10_000 === 0 && i < 10_000_000) b.tag("audit_id", `a${i}`);
  return b.data({ depositId: `d${i}`, walletId: wallet, amount: 1 + (i % 500), newBalance: 1000, depositedAt: "2026-03-15T10:00:00.000Z", description: "salary payment" }).build();
};
const transfer = (i: number) => {
  const from = `w${i % WALLETS}`, to = `w${(i * 7 + 1) % WALLETS}`;
  return AppendEvent.builder("MoneyTransferred").tag("transfer_id", `t${i}`).tag("from_wallet_id", from).tag("to_wallet_id", to).tag("year", "2026").tag("month", String(1 + (i % MONTHS)))
    .tag("from_statement_id", `${from}-2026-1`).tag("to_statement_id", `${to}-2026-1`).data({ transferId: `t${i}`, fromWalletId: from, toWalletId: to, amount: 5, fromBalance: 1, toBalance: 2, transferredAt: "2026-03-15T10:00:00.000Z", description: "gift" }).build();
};
const nextEvent = (i: number) => (i % 20 === 0 ? transfer(i) : deposit(i));

const WALLET_KEYS = new Set(["wallet_id", "from_wallet_id", "to_wallet_id"]);
const selections: Record<string, EventSelection.EventSelection> = {
  "a view (5 event types + the 3 wallet keys)": EventSelection.of({ eventTypes: new Set(["WalletOpened", "DepositMade", "WithdrawalMade", "MoneyTransferred", "WalletClosed"]), anyOfTags: WALLET_KEYS }),
  "the outbox topic (the 3 wallet keys, any type)": EventSelection.of({ anyOfTags: WALLET_KEYS }),
  "a rare key (audit_id, 0.01 %)": EventSelection.of({ anyOfTags: new Set(["audit_id"]) }),
  "required transfer_id on transfers": EventSelection.of({ eventTypes: new Set(["MoneyTransferred"]), requiredTags: new Set(["transfer_id"]) })
};

describe("DIAG", () => {
  it("E9d: the poller's real queries, tag table against scanning the events' own tags", { timeout: 2_400_000 }, async () => {
    const t0 = performance.now();
    await runtime.runPromise(Effect.gen(function* () {
      const es = yield* EventStore;
      for (let start = 0; start < N; start += 200) yield* es.append(Array.from({ length: Math.min(200, N - start) }, (_, k) => nextEvent(start + k)));
    }));
    await q("VACUUM ANALYZE crablet_events"); await q("VACUUM ANALYZE crablet_event_tag_keys");
    line(`E9d loaded ${N} events through the real append path in ${((performance.now() - t0) / 1000).toFixed(0)} s`);

    const at = async (offsetFromEnd: number) => {
      const r = (await q<{ x: string; p: string }>(`SELECT transaction_id::text AS x, position::text AS p FROM crablet_events ORDER BY transaction_id, position OFFSET ${Math.max(0, N - offsetFromEnd)} LIMIT 1`))[0]!;
      return ProgressCursorNS.of(r.x, BigInt(r.p));
    };
    const tail = await at(5_000), end = await at(1), recent = await at(100_000);
    const strategies: ReadonlyArray<TagKeyStrategy> = ["table", "scan"];
    const time = async (runs: number, f: () => Promise<unknown>) => { await f(); const xs: number[] = []; for (let i = 0; i < runs; i++) { const t = performance.now(); await f(); xs.push(performance.now() - t); } return `${pct(xs, 50).toFixed(1)} ms / ${pct(xs, 95).toFixed(1)} ms`; };
    const fetch = (sel: EventSelection.EventSelection, s: TagKeyStrategy, from: ProgressCursorNS.ProgressCursor) => runtime.runPromise(Effect.flatMap(makeSqlEventFetcher<string>(sel, { tagKeys: s }), (f) => f.fetchEvents("p", from, 100)));
    const pending = (sel: EventSelection.EventSelection, s: TagKeyStrategy, after: ProgressCursorNS.ProgressCursor, upTo: ProgressCursorNS.ProgressCursor) => runtime.runPromise(hasPendingSelectedEvents(sel, after, upTo, { tagKeys: s }));

    for (const [name, sel] of Object.entries(selections)) {
      line(`E9d fetch of 100 for ${name}, p50 / p95`);
      for (const [label, from, runs] of [["tail (last 5,000 events)", tail, 15], ["catch-up from the start", ProgressCursorNS.zero, name.startsWith("a rare") ? 3 : 15]] as const) {
        const cells: string[] = [];
        for (const s of strategies) cells.push(`${s}: ${await time(runs, () => fetch(sel, s, from))}`);
        line(`E9d    ${label.padEnd(26)} ${cells.join("   |   ")}`);
      }
    }
    line("E9d the 'anything pending?' check (SELECT 1 ... LIMIT 1 over (after, upTo]), p50 / p95");
    const pendingCases: ReadonlyArray<readonly [string, EventSelection.EventSelection, ProgressCursorNS.ProgressCursor, ProgressCursorNS.ProgressCursor, number]> = [
      ["a view, last 5,000 events (matches at once)", selections["a view (5 event types + the 3 wallet keys)"]!, tail, end, 15],
      ["a view, last 100,000 events (matches at once)", selections["a view (5 event types + the 3 wallet keys)"]!, recent, end, 15],
      ["rare key, last 5,000 (usually NOTHING pending: scans the range)", selections["a rare key (audit_id, 0.01 %)"]!, tail, end, 15],
      ["rare key, last 100,000 (scans the range until the first match)", selections["a rare key (audit_id, 0.01 %)"]!, recent, end, 8],
      ["key that never occurs, last 100,000 (NOTHING pending: scans the whole range)", EventSelection.of({ anyOfTags: new Set(["never_there"]) }), recent, end, 5]
    ];
    for (const [label, sel, after, upTo, runs] of pendingCases) {
      const cells: string[] = [];
      for (const s of strategies) cells.push(`${s}: ${await time(runs, () => pending(sel, s, after, upTo))}`);
      line(`E9d    ${label}\n         ${cells.join("   |   ")}`);
    }
  });

  it("E9e: five pollers and a writer at once: as built against no tag table", { timeout: 2_400_000 }, async () => {
    const SECONDS = 20, READERS = 5;
    const wallet = selections["a view (5 event types + the 3 wallet keys)"]!, outbox = selections["the outbox topic (the 3 wallet keys, one type any)".length ? "the outbox topic (the 3 wallet keys, any type)" : ""]!;
    const phase = async (label: string, strategy: TagKeyStrategy, offset: number) => {
      const deadline = performance.now() + SECONDS * 1000;
      let written = 0;
      const writer = (async () => {
        let i = offset;
        while (performance.now() < deadline) {
          await runtime.runPromise(Effect.flatMap(EventStore, (es) => es.append(Array.from({ length: 50 }, (_, k) => nextEvent(i + k)))));
          i += 50; written += 50;
        }
      })();
      const latencies: number[][] = [];
      const readerLoop = async (sel: EventSelection.EventSelection, sink: number[]) => {
        const start = (await q<{ x: string; p: string }>("SELECT transaction_id::text AS x, position::text AS p FROM crablet_events ORDER BY transaction_id DESC, position DESC LIMIT 1"))[0]!;
        let cursor = ProgressCursorNS.of(start.x, BigInt(start.p));
        const fetcher = await runtime.runPromise(makeSqlEventFetcher<string>(sel, { tagKeys: strategy }));
        while (performance.now() < deadline) {
          const t = performance.now();
          const events = await runtime.runPromise(fetcher.fetchEvents("p", cursor, 100));
          // the poller also asks whether it is caught up
          if (events.length > 0) cursor = ProgressCursorNS.of(events[events.length - 1]!.transactionId, events[events.length - 1]!.position);
          else await runtime.runPromise(hasPendingSelectedEvents(sel, cursor, cursor, { tagKeys: strategy }));
          sink.push(performance.now() - t);
          if (events.length === 0) await new Promise((r) => setTimeout(r, 5));
        }
      };
      for (let r = 0; r < READERS; r++) latencies.push([]);
      await Promise.all([writer, ...latencies.map((sink, r) => readerLoop(r === READERS - 1 ? outbox : wallet, sink))]);
      const all = latencies.flat();
      line(`E9e ${label}: writer ${(written / SECONDS).toFixed(0)} events/s; ${READERS} pollers made ${all.length} fetches, latency p50 ${pct(all, 50).toFixed(1)} ms, p95 ${pct(all, 95).toFixed(1)} ms, p99 ${pct(all, 99).toFixed(1)} ms`);
    };
    await phase("shipped (V11: key table written, pollers use it)", "table", 50_000_000);
    const def = (await q<{ d: string }>("SELECT pg_get_functiondef('append_events_batch(text[], text[], jsonb[], timestamptz, uuid, bigint)'::regprocedure) AS d"))[0]!.d;
    const stripped = def.replace(/,\s*tagged AS \([\s\S]*?WHERE tag LIKE '%=%'\)/u, "");
    if (stripped === def) { line("E9e could not strip the tag-row insert from the append function; skipping the second phase"); return; }
    await q(stripped);
    await phase("alternative (scan, no tag rows; function altered in this scratch database)", "scan", 60_000_000);
  });
});
