// The kind lab (ADR-0022, arrangement C). Not a test: it measures and prints `LAB` lines, with a verdict where there is a criterion.
//   node examples/wallet-example-app/lab/lab.ts up             create the cluster (3 nodes), build and load the image
//   node examples/wallet-example-app/lab/lab.ts run <name>...  run scenarios (each starts from an empty database and a fresh deployment); no names = all
//   node examples/wallet-example-app/lab/lab.ts observe       up, then a deployment you can watch: Grafana, a load of 1 to 100 commands every 30 s, the admin API (prints the addresses)
//   node examples/wallet-example-app/lab/lab.ts down           delete the cluster
// Needs Docker, kind and kubectl (1.30 or later: `kubectl debug --profile=netadmin`). BUILD=0 reuses the image already built.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..", "..");
const CLUSTER = "crablet-lab";
const CTX = `kind-${CLUSTER}`;
const IMAGE = "crablet-wallet:lab";
const MIGRATIONS_IMAGE = "crablet-migrations:lab";
const POSTGRES_IMAGE = "postgres:18.6-alpine";
const NETSHOOT = "nicolaka/netshoot:v0.14";
const API = "http://127.0.0.1:8081";
// the advisory lock keys of the three modules (packages/eventstore/src/Leader.ts)
const LOCKS = { outbox: "4856221667890123456", views: "4856221667890123457", automations: "4856221667890123458" } as const;

const run = (cmd: string, args: ReadonlyArray<string>, opts: { input?: string; quiet?: boolean } = {}): string => {
  try {
    return execFileSync(cmd, [...args], { encoding: "utf-8", input: opts.input, stdio: ["pipe", "pipe", opts.quiet ? "pipe" : "inherit"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (opts.quiet) return "";
    throw e;
  }
};
const kubectl = (...args: string[]) => run("kubectl", ["--context", CTX, ...args]);
const kubectlQuiet = (...args: string[]) => run("kubectl", ["--context", CTX, ...args], { quiet: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (line: string) => console.log(`LAB ${line}`);

// ---- cluster ----------------------------------------------------------------------------------------------------------------------------------------------

const clusterExists = () => run("kind", ["get", "clusters"], { quiet: true }).split("\n").includes(CLUSTER);

const up = (): void => {
  if (!clusterExists()) run("kind", ["create", "cluster", "--name", CLUSTER, "--config", path.join(here, "cluster.yaml")]);
  if (process.env["BUILD"] !== "0") run("docker", ["build", "-f", path.join(repoRoot, "examples/wallet-example-app/Dockerfile"), "-t", IMAGE, repoRoot]);
  run("kind", ["load", "docker-image", IMAGE, "--name", CLUSTER]);
  if (process.env["BUILD"] !== "0") run("docker", ["build", "-f", path.join(repoRoot, "examples/wallet-example-app/Dockerfile.migrations"), "-t", MIGRATIONS_IMAGE, repoRoot]);
  run("kind", ["load", "docker-image", MIGRATIONS_IMAGE, "--name", CLUSTER]);
  // The public images (Postgres, the debug container) are pulled by the cluster itself: `kind load` of a multi-platform image fails with Docker Desktop's image store ("content digest ... not found").
  log(`cluster ${CLUSTER} is up`);
};

const down = (): void => { run("kind", ["delete", "cluster", "--name", CLUSTER], { quiet: true }); log("cluster deleted"); };

// ---- a deployment from the manifests ---------------------------------------------------------------------------------------------------------------------

interface Deployment {
  readonly pgSettings: ReadonlyArray<string>; // server settings, "name=value"
  readonly pool: number;
  readonly apiReplicas: number;
  readonly workerReplicas: number;
  readonly migrate: boolean; // run the pre-deploy job
  readonly observe?: boolean; // Grafana in the cluster, and the wallet pods export to it
}
// What a managed Postgres sets for keepalives out of the box (RDS: 300 s idle, 30 s interval, 2 probes) against settings an operator would choose.
const KEEPALIVE_RDS = ["tcp_keepalives_idle=300", "tcp_keepalives_interval=30", "tcp_keepalives_count=2"];
const KEEPALIVE_TUNED = ["tcp_keepalives_idle=10", "tcp_keepalives_interval=5", "tcp_keepalives_count=3"];
// Keepalives only run on an idle connection; one with data the peer never acknowledges is governed by the retransmission timeout instead. tcp_user_timeout caps exactly that.
const KEEPALIVE_TUNED_UTO = [...KEEPALIVE_TUNED, "tcp_user_timeout=15000"];
type NetProfile = "tuned" | "uto" | "rds";
const settingsOf = (p: NetProfile) => (p === "rds" ? KEEPALIVE_RDS : p === "uto" ? KEEPALIVE_TUNED_UTO : KEEPALIVE_TUNED);
const expectedSeconds = (p: NetProfile) => (p === "rds" ? 360 : p === "uto" ? 15 : 25);
const profileText = (p: NetProfile) => (p === "rds" ? "as RDS sets them (300/30/2)" : p === "uto" ? "tuned (10/5/3) plus tcp_user_timeout=15 s" : "tuned (10/5/3)");
const standard: Deployment = { pgSettings: [], pool: 10, apiReplicas: 2, workerReplicas: 2, migrate: true };

const render = (file: string, vars: Record<string, string>): string =>
  readFileSync(path.join(here, "manifests", file), "utf-8").replace(/\$\{(\w+)\}/g, (_, k: string) => vars[k] ?? (() => { throw new Error(`no value for ${k} in ${file}`); })());

const apply = (yaml: string): void => { run("kubectl", ["--context", CTX, "apply", "-f", "-"], { input: yaml }); };

const reset = (): void => {
  kubectlQuiet("delete", "deployment", "wallet-api", "wallet-workers", "postgres", "grafana", "loadgen", "--ignore-not-found", "--wait=true");
  kubectlQuiet("delete", "job", "--all", "--ignore-not-found", "--wait=true");
  for (const n of kubectlQuiet("get", "nodes", "-o", "name").split("\n").filter(Boolean)) void n; // nodes are started again by the scenarios that stop them
};

const deployPostgres = (d: Deployment): void => {
  const args = ["-c", "max_connections=100", ...d.pgSettings.flatMap((s) => ["-c", s])];
  apply(render("postgres.yaml", { PG_ARGS: JSON.stringify(args) }));
  kubectl("rollout", "status", "deployment/postgres", "--timeout=120s");
};
const runMigrate = (name: string, parallelism: number, mode: "apply" | "if-fresh"): void => {
  apply(render("migrate-job.yaml", { MIGRATE_NAME: name, MIGRATE_PARALLELISM: String(parallelism), MIGRATE_MODE: mode }));
};
const runFlyway = (name: string, parallelism: number): void => {
  apply(render("flyway-job.yaml", { FLYWAY_NAME: name, FLYWAY_PARALLELISM: String(parallelism) }));
};
const OTEL_ENV = "            - { name: OTEL_EXPORTER_OTLP_ENDPOINT, value: \"http://grafana:4318\" }";
const deployGrafana = (): void => {
  // the dashboard, its provider and the alerts, from the files the compose stack mounts
  const config = run("kubectl", ["--context", CTX, "create", "configmap", "grafana-crablet", `--from-file=${path.join(repoRoot, "ops/grafana")}`, "--dry-run=client", "-o", "yaml"]);
  apply(config);
  apply(readFileSync(path.join(here, "manifests", "grafana.yaml"), "utf-8"));
  kubectl("rollout", "status", "deployment/grafana", "--timeout=300s");
};
const deployWallet = (d: Deployment): void => {
  apply(render("wallet.yaml", { API_REPLICAS: String(d.apiReplicas), WORKER_REPLICAS: String(d.workerReplicas), POOL: String(d.pool), OTEL_ENV: d.observe === true ? OTEL_ENV : "" }));
  kubectl("rollout", "status", "deployment/wallet-api", "--timeout=180s");
  kubectl("rollout", "status", "deployment/wallet-workers", "--timeout=180s");
};

const fresh = (d: Deployment = standard): void => {
  reset();
  if (d.observe === true) deployGrafana(); // first, so the wallet pods can resolve it
  deployPostgres(d);
  if (d.migrate) {
    runMigrate("migrate", 1, "apply");
    kubectl("wait", "--for=condition=complete", "job/migrate", "--timeout=120s");
  }
  deployWallet(d);
};

// ---- the database from the host --------------------------------------------------------------------------------------------------------------------------

const connect = async (): Promise<Client> => {
  const client = new Client({ host: "127.0.0.1", port: 5433, database: "wallet_db", user: "postgres", password: "postgres", application_name: "lab", connectionTimeoutMillis: 5000 });
  client.on("error", () => {});
  await client.connect();
  return client;
};
const q = async <T>(text: string, params: unknown[] = []): Promise<ReadonlyArray<T>> => {
  const client = await connect();
  try { return (await client.query(text, params)).rows as T[]; } finally { await client.end().catch(() => {}); }
};

const podIps = (): Map<string, string> => {
  const pods = JSON.parse(kubectlQuiet("get", "pods", "-l", "app=wallet", "-o", "json")) as { items: Array<{ metadata: { name: string }; status: { podIP?: string } }> };
  return new Map(pods.items.filter((p) => p.status.podIP).map((p) => [p.status.podIP!, p.metadata.name]));
};
// Which pod leads a module: the pod whose address owns the module's session-level advisory lock.
const leaderOf = async (module: keyof typeof LOCKS): Promise<string | undefined> => {
  const rows = await q<{ ip: string }>(
    `SELECT a.client_addr::text AS ip FROM pg_locks l JOIN pg_stat_activity a USING (pid)
      WHERE l.locktype = 'advisory' AND l.granted AND ((l.classid::bigint << 32) | l.objid::bigint)::text = $1`, [LOCKS[module]]);
  const ips = podIps();
  return rows.length === 0 ? undefined : ips.get(rows[0]!.ip.replace(/\/\d+$/, "")) ?? `unknown(${rows[0]!.ip})`;
};
const waitForLeader = async (module: keyof typeof LOCKS, timeoutMs = 120_000): Promise<string> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const l = await leaderOf(module).catch(() => undefined);
    if (l !== undefined) return l;
    if (Date.now() > end) throw new Error(`no leader for ${module} after ${timeoutMs} ms`);
    await sleep(500);
  }
};
// Milliseconds until a module is led by a pod other than `old` (or by anyone, if `old` is gone).
const takeoverMs = async (module: keyof typeof LOCKS, old: string, from: number, timeoutMs: number): Promise<number | null> => {
  for (;;) {
    const l = await leaderOf(module).catch(() => undefined);
    if (l !== undefined && l !== old) return Date.now() - from;
    if (Date.now() - from > timeoutMs) return null;
    await sleep(250);
  }
};

// A fingerprint of the schema the migrations leave behind (tables, indexes, constraints, functions), to tell a complete schema from one that has the right tables and is missing the rest.
const schemaFingerprint = async (): Promise<{ fp: string; objects: number }> => {
  const rows = await q<{ fp: string; n: string }>(
    `SELECT coalesce(md5(string_agg(x, ',' ORDER BY x)), '') AS fp, count(*)::text AS n FROM (
       SELECT 't:' || tablename AS x FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'flyway%'
       UNION ALL SELECT 'i:' || indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename NOT LIKE 'flyway%'
       UNION ALL SELECT 'f:' || proname || '/' || pronargs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
       UNION ALL SELECT 'c:' || conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' AND conrelid::regclass::text NOT LIKE 'flyway%'
     ) s`);
  return { fp: rows[0]!.fp, objects: Number(rows[0]!.n) };
};
// The schema one migration run leaves on an empty database: what a race must end up with.
const referenceSchema = async (): Promise<{ fp: string; objects: number }> => {
  reset();
  deployPostgres(standard);
  runMigrate("migrate-ref", 1, "apply");
  kubectl("wait", "--for=condition=complete", "job/migrate-ref", "--timeout=120s");
  return schemaFingerprint();
};
const raceOutcome = async (name: string, job: string, reference: { fp: string; objects: number }, extra: () => Promise<string>) => {
  const end = Date.now() + 120_000;
  let status = "";
  while (Date.now() < end) {
    status = kubectl("get", "job", job, "-o", "jsonpath={.status.succeeded}/{.status.failed}/{.status.active}");
    const [ok, bad, active] = status.split("/").map((x) => Number(x || 0));
    if ((active ?? 0) === 0 && (ok ?? 0) + (bad ?? 0) >= 5) break;
    await sleep(2000);
  }
  const [succeeded, failed] = status.split("/").map((x) => Number(x || 0));
  const now = await schemaFingerprint();
  const complete = now.fp === reference.fp;
  log(`${name}: ${succeeded} pods succeeded and ${failed} failed; the schema has ${now.objects} objects (a single run leaves ${reference.objects}) and ${complete ? "is identical to" : "DIFFERS from"} the single-run schema${await extra()}`);
  log(`${name}: ${verdict(failed === 0 && complete, "every pod finishes without error and the schema equals the single-run schema")}`);
};

// ---- load and measurement ---------------------------------------------------------------------------------------------------------------------------------

// Commands through the API at a steady rate. Every 201 is an acknowledged wallet that MUST end up in the views.
class Load {
  readonly acked: string[] = [];
  failed = 0;
  private running = false;
  private tasks: Promise<void>[] = [];
  private readonly perSecond: number;
  constructor(perSecond: number) { this.perSecond = perSecond; }
  start(): void {
    this.running = true;
    void (async () => {
      while (this.running) {
        this.tasks.push(this.one());
        await sleep(1000 / this.perSecond);
      }
    })();
  }
  private async one(): Promise<void> {
    const walletId = `w-${crypto.randomUUID()}`;
    try {
      const res = await fetch(`${API}/api/commands/open_wallet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ walletId, owner: "lab", initialBalance: 1 }), signal: AbortSignal.timeout(8000) });
      if (res.status === 201) this.acked.push(walletId); else this.failed++;
    } catch { this.failed++; }
  }
  async stop(): Promise<void> { this.running = false; await Promise.all(this.tasks); }
}

// How far behind the balance view is: the age of the oldest WalletOpened event (the only thing the load writes that the view reads) past its cursor. Not the minimum over the four views:
// the statement and transaction views read events this load never writes, so their cursors stay at 0 and would make the lag the age of the log.
const LAG_SQL = `SELECT coalesce(extract(epoch from now() - min(occurred_at)), 0)::float AS lag FROM crablet_events
                  WHERE type = 'WalletOpened' AND position > (SELECT coalesce(max(last_position), 0) FROM crablet_view_progress WHERE view_name = 'wallet-balance-view')`;
// How far behind the views are, as that query measures it. Sampled while a scenario runs.
class Lag {
  readonly samples: Array<{ at: number; lag: number }> = [];
  private running = false;
  private done: Promise<void> = Promise.resolve();
  start(everyMs = 250): void {
    this.running = true;
    this.done = (async () => {
      let client: Client | undefined;
      while (this.running) {
        try {
          client ??= await connect();
          const r = await client.query(LAG_SQL);
          this.samples.push({ at: Date.now(), lag: r.rows[0].lag as number });
        } catch { await client?.end().catch(() => {}); client = undefined; }
        await sleep(everyMs);
      }
      await client?.end().catch(() => {});
    })();
  }
  async stop(): Promise<void> { this.running = false; await this.done; }
  max(since = 0): number { return Math.max(0, ...this.samples.filter((s) => s.at >= since).map((s) => s.lag)); }
  // seconds from `since` until the lag is below `threshold` for good (the last sample above it)
  settledAfter(since: number, threshold = 2): number {
    const above = this.samples.filter((s) => s.at >= since && s.lag >= threshold);
    return above.length === 0 ? 0 : (above[above.length - 1]!.at - since) / 1000;
  }
}

// Every acknowledged wallet must reach the balance view: nothing lost, whatever the disruption did.
const settle = async (load: Load, waitMs = 90_000): Promise<{ missing: number; seconds: number }> => {
  const t0 = Date.now();
  let missing = load.acked.length;
  while (Date.now() - t0 < waitMs) {
    const rows = await q<{ n: string }>("SELECT count(*)::text AS n FROM wallet_balance_view WHERE wallet_id = ANY($1)", [load.acked]).catch(() => undefined);
    if (rows) { missing = load.acked.length - Number(rows[0]!.n); if (missing === 0) break; }
    await sleep(500);
  }
  return { missing, seconds: (Date.now() - t0) / 1000 };
};

const verdict = (ok: boolean, criterion: string) => `${ok ? "PASS" : "FAIL"} (${criterion})`;
const lagReport = (lag: Lag, since: number) => `max view lag ${lag.max(since).toFixed(1)} s, back under 2 s ${lag.settledAfter(since).toFixed(1)} s after the disruption`;

// ---- scenarios ---------------------------------------------------------------------------------------------------------------------------------------------

interface Scenario { readonly name: string; readonly describe: string; readonly run: () => Promise<void> }

const withLoad = async <T>(perSecond: number, body: (load: Load, lag: Lag) => Promise<T>): Promise<T> => {
  await waitForLeader("views");
  const load = new Load(perSecond);
  const lag = new Lag();
  lag.start();
  load.start();
  await sleep(5000); // a steady state before the disruption
  try { return await body(load, lag); } finally { await load.stop(); await lag.stop(); }
};
const finish = async (name: string, load: Load, lag: Lag, since: number, extra: string, criterion: { ok: boolean; text: string }) => {
  const s = await settle(load);
  log(`${name}: ${lagReport(lag, since)}; ${load.acked.length} commands acknowledged, ${load.failed} failed, ${s.missing} missing from the views after ${s.seconds.toFixed(0)} s${extra ? `; ${extra}` : ""}`);
  log(`${name}: ${verdict(criterion.ok && s.missing === 0, `${criterion.text}, and nothing acknowledged is lost`)}`);
};

const scenarios: Scenario[] = [
  {
    name: "rolling",
    describe: "rolling update of the workers while commands flow: no gap in the views",
    run: async () => {
      fresh();
      await withLoad(5, async (load, lag) => {
        const t0 = Date.now();
        kubectl("rollout", "restart", "deployment/wallet-workers");
        kubectl("rollout", "status", "deployment/wallet-workers", "--timeout=180s");
        await sleep(5000);
        await finish("rolling", load, lag, t0, `rollout took ${((Date.now() - t0) / 1000).toFixed(0)} s`, { ok: lag.max(t0) <= 10, text: "max view lag at most 10 s" });
      });
    }
  },
  {
    name: "kill",
    describe: "the leader of the views is killed (no graceful stop): another pod takes over",
    run: async () => {
      fresh();
      await withLoad(5, async (load, lag) => {
        const leader = await waitForLeader("views");
        const t0 = Date.now();
        kubectl("delete", "pod", leader, "--grace-period=0", "--force");
        const took = await takeoverMs("views", leader, t0, 60_000);
        await sleep(5000);
        await finish("kill", load, lag, t0, `leader ${leader} killed; another pod led the views after ${took === null ? "never" : `${(took / 1000).toFixed(1)} s`}`, { ok: took !== null && took <= 15_000, text: "takeover within 15 s" });
      });
    }
  },
  ...(["tuned", "uto", "rds"] as const).map((profile): Scenario => ({
    name: `partition-${profile}`,
    describe: `the leader loses the network to Postgres without a reset (a packet drop), Postgres keepalives ${profileText(profile)}`,
    run: async () => {
      fresh({ ...standard, pgSettings: settingsOf(profile) });
      await withLoad(5, async (load, lag) => {
        const leader = await waitForLeader("views");
        const pg = kubectl("get", "service", "postgres", "-o", "jsonpath={.spec.clusterIP}").trim();
        const pgPod = podIpOf("postgres");
        // Rules inside the leader's own network namespace, from an ephemeral container: only Postgres is unreachable, so the kubelet's probes still pass and the pod is not restarted.
        const rules = [pg, pgPod].flatMap((ip) => [`iptables -A OUTPUT -d ${ip} -j DROP`, `iptables -A INPUT -s ${ip} -j DROP`]).join(" && ");
        const t0 = Date.now();
        kubectl("debug", leader, "--image", NETSHOOT, "--profile=netadmin", "--target=wallet", "--quiet", "--", "sh", "-c", rules);
        const expected = expectedSeconds(profile);
        const took = await takeoverMs("views", leader, t0, Math.max(expected + 90, 420) * 1000);
        await sleep(5000);
        await finish(`partition-${profile}`, load, lag, t0, `another pod led the views after ${took === null ? "never" : `${(took / 1000).toFixed(0)} s`} (keepalives allow about ${expected} s)`, { ok: took !== null && took <= (expected + 30) * 1000, text: `takeover within the keepalive time plus 30 s` });
      });
    }
  })),
  ...(["tuned", "rds"] as const).map((profile): Scenario => ({
    name: `node-loss-${profile}`,
    describe: `the node of the views leader stops, Postgres keepalives ${profileText(profile)}`,
    run: async () => {
      fresh({ ...standard, pgSettings: settingsOf(profile) });
      await withLoad(5, async (load, lag) => {
        const leader = await waitForLeader("views");
        const node = kubectl("get", "pod", leader, "-o", "jsonpath={.spec.nodeName}").trim();
        const t0 = Date.now();
        run("docker", ["stop", node], { quiet: true });
        const took = await takeoverMs("views", leader, t0, (expectedSeconds(profile) + 120) * 1000);
        let notReady: number | null = null;
        for (let i = 0; i < 120 && notReady === null; i++) {
          if (kubectlQuiet("get", "node", node, "-o", "jsonpath={.status.conditions[?(@.type==\"Ready\")].status}").trim() !== "True") notReady = Date.now() - t0;
          else await sleep(1000);
        }
        await sleep(5000);
        const podState = kubectlQuiet("get", "pod", leader, "-o", "jsonpath={.status.phase}/{.metadata.deletionTimestamp}") || "gone";
        run("docker", ["start", node], { quiet: true });
        await finish(`node-loss-${profile}`, load, lag, t0, `node ${node} stopped; another pod led the views after ${took === null ? "never" : `${(took / 1000).toFixed(0)} s`}; Kubernetes marked the node not ready after ${notReady === null ? "more than 120 s" : `${(notReady / 1000).toFixed(0)} s`}; the old pod is ${podState}`, { ok: took !== null, text: "another pod takes over" });
        await sleep(15_000); // the node is back before the next scenario
      });
    }
  })),
  {
    name: "trace-kill",
    describe: "kill the views leader and print a timeline: who leads, the cursor, the head of the log, the lag; then the logs of the pods",
    run: async () => {
      fresh();
      await withLoad(5, async (load) => {
        const leader = await waitForLeader("views");
        const t0 = Date.now();
        kubectl("delete", "pod", leader, "--grace-period=0", "--force");
        const client = await connect();
        let last = "";
        while (Date.now() - t0 < 40_000) {
          const l = await leaderOf("views").catch(() => undefined);
          const r = (await client.query(
            `SELECT (SELECT last_position FROM crablet_view_progress WHERE view_name = 'wallet-balance-view')::text AS cursor, (SELECT max(position) FROM crablet_events)::text AS head,
                    coalesce(extract(epoch from now() - min(occurred_at)), 0)::float AS lag
               FROM crablet_events WHERE type = 'WalletOpened' AND position > (SELECT coalesce(max(last_position), 0) FROM crablet_view_progress WHERE view_name = 'wallet-balance-view')`)).rows[0] as { cursor: string; head: string; lag: number };
          const line = `leader=${l ?? "none"} cursor=${r.cursor} head=${r.head} lag=${r.lag.toFixed(1)}s`;
          if (line !== last) log(`trace +${((Date.now() - t0) / 1000).toFixed(1)}s ${line}`);
          last = line;
          await sleep(500);
        }
        await client.end();
        await load.stop();
        for (const pod of kubectlQuiet("get", "pods", "-l", "role=workers", "-o", "name").split("\n").filter(Boolean)) {
          log(`logs of ${pod}:`);
          for (const l of kubectlQuiet("logs", pod, "--timestamps").split("\n").filter((x) => /leader|lost|acquir|warn|error|processor|backoff/i.test(x)).slice(0, 40)) log(`  ${l.slice(0, 220)}`);
        }
      });
    }
  },
  {
    name: "migrate-race",
    describe: "five pods run the start-up migration (apply only to a fresh database) at the same moment on an empty database",
    run: async () => {
      const reference = await referenceSchema();
      reset();
      deployPostgres(standard);
      runMigrate("migrate-race", 5, "if-fresh");
      await raceOutcome("migrate-race", "migrate-race", reference, async () => {
        const errors = kubectlQuiet("logs", "-l", "job-name=migrate-race", "--tail=40", "--prefix").split("\n").filter((l) => /error:|already exists|concurrently|deadlock/i.test(l)).slice(0, 3);
        return errors.length === 0 ? "" : `; e.g. ${errors.map((l) => l.replace(/\s+/g, " ").slice(0, 120)).join(" | ")}`;
      });
    }
  },
  {
    name: "flyway-race",
    describe: "the same five pods, each running Flyway (history table and lock) instead of our script",
    run: async () => {
      const reference = await referenceSchema();
      reset();
      deployPostgres(standard);
      runFlyway("flyway-race", 5);
      await raceOutcome("flyway-race", "flyway-race", reference, async () => {
        const history = await q<{ n: string; failed: string }>("SELECT count(*)::text AS n, count(*) FILTER (WHERE NOT success)::text AS failed FROM flyway_schema_history").catch(() => [{ n: "none", failed: "?" }]);
        const applied = kubectlQuiet("logs", "-l", "job-name=flyway-race", "--tail=200").split("\n").filter((l) => /Successfully applied|Schema .* is up to date|Migrating schema/i.test(l));
        return `; flyway_schema_history has ${history[0]!.n} rows (${history[0]!.failed} failed); the pods' logs: ${applied.length} lines about applying`;
      });
    }
  },
  {
    name: "connections",
    describe: "Postgres with max_connections=20 against four pods with a pool of 10 each, under load",
    run: async () => {
      fresh({ ...standard, pgSettings: ["max_connections=20"] });
      const load = new Load(10);
      load.start();
      await sleep(40_000);
      await load.stop();
      const restarts = kubectlQuiet("get", "pods", "-l", "app=wallet", "-o", "jsonpath={range .items[*]}{.metadata.name}={.status.containerStatuses[0].restartCount}/{.status.containerStatuses[0].ready} {end}");
      const used = await q<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = 'wallet_db'").catch(() => [{ n: "unreachable" }]);
      const errors = kubectlQuiet("logs", "-l", "app=wallet", "--tail=200", "--prefix").split("\n").filter((l) => /too many clients|remaining connection slots/i.test(l));
      log(`connections: ${load.acked.length} commands acknowledged, ${load.failed} failed; ${used[0]!.n} connections open; pods (restarts/ready): ${restarts.trim()}`);
      log(`connections: ${errors.length} log lines say the server is out of connections${errors[0] ? ` -- e.g. ${errors[0].slice(0, 160)}` : ""}`);
      log(`connections: ${verdict(load.failed === 0 && errors.length === 0, "no command fails and no pod reports running out of connections")}`);
    }
  },
  {
    name: "long-tx",
    describe: "a transaction that holds a transaction id for 30 s (a stuck job, an idle-in-transaction session) while commands flow",
    run: async () => {
      fresh();
      await withLoad(5, async (load, lag) => {
        const blocker = await connect();
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_current_xact_id()"); // assigns an id: the processors cannot move past events committed after it
        const t0 = Date.now();
        await sleep(30_000);
        const during = lag.max(t0);
        await blocker.query("COMMIT");
        const t1 = Date.now();
        await blocker.end();
        await sleep(8000);
        await finish("long-tx", load, lag, t1, `during the 30 s transaction the lag reached ${during.toFixed(1)} s (the views waited for it)`, { ok: lag.settledAfter(t1) <= 10, text: "back under 2 s within 10 s of the commit" });
      });
    }
  }
];

const podIpOf = (app: string): string => kubectl("get", "pod", "-l", `app=${app}`, "-o", "jsonpath={.items[0].status.podIP}").trim();

// ---- main --------------------------------------------------------------------------------------------------------------------------------------------------

const observe = (): void => {
  up();
  fresh({ ...standard, observe: true });
  apply(readFileSync(path.join(here, "manifests", "loadgen.yaml"), "utf-8"));
  kubectl("rollout", "status", "deployment/loadgen", "--timeout=120s");
  console.log(`
LAB observation is up. Open:

  Grafana (the Crablet dashboard)   http://localhost:3000        login admin / admin; Dashboards, "Crablet"
  The wallet API                    http://localhost:8081        e.g. http://localhost:8081/openapi.json
  The processors admin page         run this in another terminal, then open http://localhost:5173 and connect with the token  lab-token
                                      cd examples/processors-admin-ui && ADMIN_API_URL=http://127.0.0.1:8081 bun run dev
  Postgres                          localhost:5433               user postgres, password postgres, database wallet_db

The load: every 30 seconds, 1 to 100 commands at once.  Watch it:  kubectl --context ${CTX} logs -f deploy/loadgen
Break something while you watch (the dashboard and the admin page show it):
  kubectl --context ${CTX} delete pod -l role=workers --grace-period=0 --force     (kill the workers; one takes over)
  kubectl --context ${CTX} rollout restart deployment/wallet-workers                (a rolling update)
Stop it:  node examples/wallet-example-app/lab/lab.ts down
`);
};

const [command, ...names] = process.argv.slice(2);
if (command === "up") up();
else if (command === "observe") observe();
else if (command === "down") down();
else if (command === "run") {
  const chosen = names.length === 0 ? scenarios : names.map((n) => scenarios.find((s) => s.name === n) ?? (() => { throw new Error(`unknown scenario ${n}; known: ${scenarios.map((s) => s.name).join(", ")}`); })());
  for (const s of chosen) {
    log(`--- ${s.name}: ${s.describe}`);
    try { await s.run(); } catch (e) { log(`${s.name}: ERROR ${e instanceof Error ? e.message : String(e)}`); }
  }
} else {
  console.log("usage: node lab.ts up | observe | run [scenario...] | down");
  console.log(`scenarios: ${scenarios.map((s) => s.name).join(", ")}`);
}
