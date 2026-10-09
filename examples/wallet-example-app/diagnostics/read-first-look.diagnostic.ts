// DIAGNOSTIC EXPERIMENT (docs/adr/0015-read-consistency-by-marker.md, update of 2026-10-09), not a test: it measures, it does not assert. Needs Docker (Testcontainers, and the image `alpine` for the delay).
// Run with:  node --test examples/wallet-example-app/diagnostics/read-first-look.diagnostic.ts   and read the `DIAG` lines.   QUICK=1 for fewer reads.
// The real consistent read (`makeConsistentRead`) of the wallet's balance view, before and after the first look became one statement: "before" is the wrapper with the dependencies it had
// (the end of the log, then a wait per view), "after" is the wrapper as it is now. The database's container gets a network delay (`tc netem`, on the packets that leave it), so the cost of a round
// trip shows. What is timed is the wrapper plus the application's query, not the HTTP stack. Reads alternate between the two so drift cancels; the state is the usual default read: the view is
// caught up and the last event of the log is one it does not handle, so the pending check runs.
import { after, before, describe, it } from "node:test";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { execFileSync } from "node:child_process";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutorLive } from "@crablet/commands";
import { waitUntilProcessed } from "@crablet/views/WaitUntilProcessed";
import { makeConsistentRead } from "@crablet/views-http";
import { headOfLog } from "@crablet/views-http/HeadOfLog";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { startWalletAppForTest, type CoreServices } from "../test/support/startWalletAppForTest.ts";
import { applyAppMigrations } from "../test/support/applyAppMigrations.ts";
import { walletBalanceViewSubscription, walletSummaryViewSubscription } from "../src/views/WalletViewConfig.ts";

const QUICK = process.env["QUICK"] !== undefined;
let db: TestDb;
let sidecar = "";
const sh = (...a: string[]) => execFileSync("docker", a, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

before(async () => { db = await startTestDb(); await applyAppMigrations(db.connInfo); }, { timeout: 120_000 });
after(async () => { if (sidecar) try { sh("stop", "-t", "1", sidecar); } catch {} await db.stop(); });

describe("DIAG", () => {
  it("the first look of a consistent read: before and after, under a network delay", { timeout: 1_200_000 }, async () => {
    const rt = ManagedRuntime.make(
      Layer.provideMerge(Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive),
        PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), maxConnections: 20 })) as unknown as Layer.Layer<CoreServices, never>
    );
    const run = <A, E>(e: Effect.Effect<A, E, any>) => rt.runPromise(e as Effect.Effect<A, never, any>);
    try {
      // wallets, with the views caught up by a full instance that then stops; one marker per wallet
      const full = await startWalletAppForTest(rt);
      const ids = Array.from({ length: 20 }, () => `w-${crypto.randomUUID()}`);
      const markers: string[] = [];
      for (const id of ids) {
        await fetch(`${full.baseUrl}/api/commands/open_wallet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletId: id, owner: "x", initialBalance: 1 }) });
        const d = await fetch(`${full.baseUrl}/api/commands/deposit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ depositId: crypto.randomUUID(), walletId: id, amount: 5, description: "d" }) });
        markers.push(((await d.json()) as { marker: string }).marker);
      }
      for (const suffix of ["", "/transactions", "/summary"]) await (await fetch(`${full.baseUrl}/api/wallets/${ids[ids.length - 1]}${suffix}`)).text();
      await sleep(500);
      await full.stop();
      await run(Effect.flatMap(EventStore, (s) => s.append([AppendEvent.of("UnrelatedForDiag", "unrelated", "x", {})]))); // the last event is one no view handles

      interface Req { readonly query: { readonly consistentWith?: string; readonly id?: string } }
      const endpointFor = (reads: typeof walletBalanceViewSubscription[], after_: boolean) => {
        const read = after_ ? makeConsistentRead() : makeConsistentRead({ deps: { head: headOfLog, wait: waitUntilProcessed } });
        return read(
          { reads, parse: (req: Req) => Effect.succeed(req.query.id!) },
          (id: string) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("SELECT * FROM wallet_balance_view WHERE wallet_id = $1", [id]))
        ) as (req: Req) => Effect.Effect<unknown, unknown, SqlClient.SqlClient>;
      };
      const scenarios: ReadonlyArray<readonly [string, typeof walletBalanceViewSubscription[], boolean]> = [
        ["default read, one view", [walletBalanceViewSubscription], false],
        ["read with the write's marker, one view", [walletBalanceViewSubscription], true],
        ["default read, two views (balance + summary)", [walletBalanceViewSubscription, walletSummaryViewSubscription], false]
      ];

      sidecar = sh("run", "-d", "--rm", "--cap-add", "NET_ADMIN", "--network", `container:${db.container.getId()}`, "alpine", "sh", "-c", "apk add -q iproute2-tc && tc qdisc add dev eth0 root netem delay 0ms && sleep 3600");
      for (let i = 0; i < 60; i++) { try { if (sh("exec", sidecar, "tc", "qdisc", "show", "dev", "eth0").includes("netem")) break; } catch {} await sleep(500); }

      const READS = QUICK ? 60 : 300;
      for (const delay of [0, 0.5, 1, 2]) {
        sh("exec", sidecar, "tc", "qdisc", "change", "dev", "eth0", "root", "netem", "delay", `${delay}ms`);
        await sleep(300);
        const rtt: number[] = [];
        for (let i = 0; i < 60; i++) { const t0 = performance.now(); await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("SELECT 1"))); rtt.push(performance.now() - t0); }
        console.log(`DIAG first look [added ${delay} ms: SELECT 1 p50 ${pct(rtt, 50).toFixed(2)} ms]`);
        for (const [name, reads, withMarker] of scenarios) {
          const before_ = endpointFor(reads, false), after_ = endpointFor(reads, true);
          const call = (ep: typeof before_) => { const i = Math.floor(Math.random() * ids.length); return run(ep({ query: { id: ids[i]!, ...(withMarker ? { consistentWith: markers[i]! } : {}) } })); };
          for (let i = 0; i < 30; i++) { await call(before_); await call(after_); }
          const lat = { before: [] as number[], after: [] as number[] };
          for (let i = 0; i < READS; i++) {
            for (const mode of (i % 2 === 0 ? ["before", "after"] : ["after", "before"]) as Array<"before" | "after">) {
              const t0 = performance.now(); await call(mode === "before" ? before_ : after_); lat[mode].push(performance.now() - t0);
            }
          }
          const thr: Record<string, number> = {};
          for (const mode of ["before", "after"] as const) {
            let stop = false, n = 0;
            const loops = Array.from({ length: 16 }, async () => { while (!stop) { await call(mode === "before" ? before_ : after_); n++; } });
            const t0 = performance.now(); await sleep(QUICK ? 1500 : 3000); stop = true; await Promise.all(loops);
            thr[mode] = n / ((performance.now() - t0) / 1000);
          }
          console.log(`DIAG    ${name.padEnd(46)} before p50 ${pct(lat.before, 50).toFixed(2)} p95 ${pct(lat.before, 95).toFixed(2)} | after p50 ${pct(lat.after, 50).toFixed(2)} p95 ${pct(lat.after, 95).toFixed(2)} | saved p50 ${(pct(lat.before, 50) - pct(lat.after, 50)).toFixed(2)} ms | 16 concurrent ${thr["before"]!.toFixed(0)} -> ${thr["after"]!.toFixed(0)} reads/s`);
        }
      }
      sh("exec", sidecar, "tc", "qdisc", "change", "dev", "eth0", "root", "netem", "delay", "0ms");
    } finally {
      await rt.dispose();
    }
  });
});
