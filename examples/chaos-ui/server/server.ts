// The chaos lab's server (examples/chaos-ui). It runs on YOUR computer, next to the page, and does what a browser cannot: `kubectl` and a connection to the lab's Postgres.
//   node examples/chaos-ui/server/server.ts           (then: cd examples/chaos-ui && bun run dev, and open http://localhost:5175)
//
// Safe by construction, because it can delete pods and empty a database:
// - it only ever talks to the kubectl context `kind-crablet-lab` (--context on every call), and to localhost ports the kind lab publishes;
// - it listens on 127.0.0.1 only;
// - it never touches the Postgres, Grafana or load pods: a kill is for the API and worker pods, which is the point of the lab;
// - one run, one verification and one reset at a time.
// Node strips types here but does not transform: no enums, no parameter properties.
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import pg from "pg";
import { Schema } from "effect";
import { Ack, KillPod, ResetDatabase, SetLoad, StartRun, State, Verification, scenarios } from "../src/contract.ts";
import type { Check, Load, Pod } from "../src/contract.ts";
import { dataChecks } from "./checks.ts";

const CONTEXT = "kind-crablet-lab";
const PORT = Number(process.env["CHAOS_PORT"] ?? 5174);
const API = process.env["WALLET_API_URL"] ?? "http://127.0.0.1:8081";
const ADMIN_TOKEN = process.env["WALLET_ADMIN_TOKEN"] ?? "lab-token";
const DB = { host: "127.0.0.1", port: Number(process.env["WALLET_DB_PORT"] ?? 5433), database: "wallet_db", user: "postgres", password: "postgres" };
const NETSHOOT = "nicolaka/netshoot:v0.14";
// the advisory lock keys of the three modules (packages/eventstore/src/Leader.ts)
const LOCKS = { outbox: "4856221667890123456", views: "4856221667890123457", automations: "4856221667890123458" } as const;
type ModuleName = keyof typeof LOCKS;

const GRAFANA = process.env["GRAFANA_URL"] ?? "http://localhost:3000";
const GRAFANA_AUTH = `Basic ${Buffer.from(process.env["GRAFANA_AUTH"] ?? "admin:admin").toString("base64")}`;
let grafanaWarned = false;
// A mark on every Grafana graph at this moment ("Chaos faults" annotations on the dashboard), so a dip or a spike can be read against what was done. Best effort: no Grafana, no mark.
const annotate = (text: string, tags: ReadonlyArray<string> = []): void => {
  void fetch(`${GRAFANA}/api/annotations`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: GRAFANA_AUTH }, body: JSON.stringify({ text, tags: ["chaos", ...tags], time: Date.now() }), signal: AbortSignal.timeout(3000) })
    .then((res) => { if (!res.ok && !grafanaWarned) { grafanaWarned = true; console.warn(`Grafana annotations: ${res.status} (the marks on the graphs are off)`); } })
    .catch(() => { if (!grafanaWarned) { grafanaWarned = true; console.warn("Grafana is not reachable: the marks on its graphs are off"); } });
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 240);

// ---- kubectl and the database ----------------------------------------------------------------------------------------------------------------------------

const kubectl = (args: ReadonlyArray<string>, timeoutMs = 90_000): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("kubectl", ["--context", CONTEXT, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(new Error(`kubectl ${args.slice(0, 3).join(" ")}: ${(stderr || error.message).trim().split("\n")[0]}`));
      else resolve(stdout);
    });
  });

const withDb = async <T>(body: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ ...DB, application_name: "chaos-ui", connectionTimeoutMillis: 4000 });
  client.on("error", () => {});
  await client.connect();
  try { return await body(client); } finally { await client.end().catch(() => {}); }
};

// ---- the cluster ------------------------------------------------------------------------------------------------------------------------------------------

interface PodView { readonly name: string; readonly role: Pod["role"]; readonly phase: string; readonly ready: boolean; readonly restarts: number; readonly node: string; readonly ageSeconds: number; readonly ip: string }
const roleOf = (labels: Record<string, string>): Pod["role"] => {
  if (labels["role"] === "api") return "api";
  if (labels["role"] === "workers") return "workers";
  if (labels["app"] === "loadgen") return "loadgen";
  if (labels["app"] === "grafana") return "grafana";
  if (labels["app"] === "postgres") return "postgres";
  return "other";
};

const listPods = async (): Promise<ReadonlyArray<PodView>> => {
  const json = JSON.parse(await kubectl(["get", "pods", "-o", "json"])) as {
    items: Array<{ metadata: { name: string; labels?: Record<string, string>; creationTimestamp: string; deletionTimestamp?: string }; spec: { nodeName?: string }; status: { phase: string; podIP?: string; containerStatuses?: Array<{ ready: boolean; restartCount: number }> } }>;
  };
  return json.items
    .filter((p) => p.status.phase !== "Succeeded")
    .map((p) => ({
      name: p.metadata.name,
      role: roleOf(p.metadata.labels ?? {}),
      phase: p.metadata.deletionTimestamp ? "Terminating" : p.status.phase,
      ready: p.status.containerStatuses?.[0]?.ready ?? false,
      restarts: p.status.containerStatuses?.[0]?.restartCount ?? 0,
      node: p.spec.nodeName ?? "",
      ageSeconds: Math.max(0, Math.round((Date.now() - Date.parse(p.metadata.creationTimestamp)) / 1000)),
      ip: p.status.podIP ?? ""
    }));
};

// Which pod leads a module: the pod whose address owns the module's session-level advisory lock.
const leaderOf = async (module: ModuleName, pods?: ReadonlyArray<PodView>): Promise<string | null> => {
  const rows = await withDb(async (c) =>
    (await c.query(
      `SELECT a.client_addr::text AS ip FROM pg_locks l JOIN pg_stat_activity a USING (pid)
        WHERE l.locktype = 'advisory' AND l.granted AND ((l.classid::bigint << 32) | l.objid::bigint)::text = $1`, [LOCKS[module]])).rows as Array<{ ip: string }>
  );
  if (rows.length === 0) return null;
  const ip = rows[0]!.ip.replace(/\/\d+$/, "");
  const list = pods ?? (await listPods());
  return list.find((p) => p.ip === ip)?.name ?? `unknown (${ip})`;
};
const allLeaders = async (pods: ReadonlyArray<PodView>) => ({ views: await leaderOf("views", pods), automations: await leaderOf("automations", pods), outbox: await leaderOf("outbox", pods) });

// Milliseconds until the module is led by a pod other than `old`; null if that does not happen in time.
const takeoverMs = async (module: ModuleName, old: string, timeoutMs: number): Promise<number | null> => {
  const from = Date.now();
  while (Date.now() - from < timeoutMs) {
    const l = await leaderOf(module).catch(() => null);
    if (l !== null && l !== old) return Date.now() - from;
    await sleep(250);
  }
  return null;
};

// ---- the admin API ------------------------------------------------------------------------------------------------------------------------------------------

interface Processor { readonly kind: string; readonly id: string; readonly status: string; readonly errorCount: number | null; readonly pendingEvents: number | null }
const admin = async (method: string, path: string): Promise<unknown> => {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
  return res.json();
};
const processors = async (): Promise<ReadonlyArray<Processor>> => ((await admin("GET", "/admin/processors")) as { processors: Processor[] }).processors;

// ---- the load generator (steered through its control port, by a port-forward) -----------------------------------------------------------------------------

const FORWARD_PORT = 19090;
let forward: ChildProcess | null = null;
const ensureForward = async (): Promise<void> => {
  if (forward !== null && forward.exitCode === null && !forward.killed) return;
  forward = spawn("kubectl", ["--context", CONTEXT, "port-forward", "deployment/loadgen", `${FORWARD_PORT}:9090`], { stdio: ["ignore", "pipe", "ignore"] });
  const child = forward;
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    child.stdout?.on("data", (d: Buffer) => { if (String(d).includes("Forwarding")) done(); });
    child.on("exit", done);
    setTimeout(done, 4000);
  });
};
const loadCall = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ensureForward();
      const res = await fetch(`http://127.0.0.1:${FORWARD_PORT}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000) });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error(String(json["error"] ?? res.status));
      return json;
    } catch (e) {
      if (attempt === 1 || (e instanceof Error && !/fetch failed|timeout|abort|ECONN/i.test(e.message))) throw e;
      forward?.kill();
      forward = null;
    }
  }
  throw new Error("unreachable");
};
const loadStatus = async (): Promise<Load> => {
  try {
    const s = await loadCall("GET", "/status");
    return {
      running: s["running"] === true, intervalSeconds: Number(s["intervalSeconds"]), minCommands: Number(s["minCommands"]), maxCommands: Number(s["maxCommands"]),
      wallets: Number(s["wallets"]), bursting: s["inBurst"] === true, lastBurst: typeof s["lastBurst"] === "string" ? s["lastBurst"] : null
    };
  } catch (e) {
    return { running: false, intervalSeconds: 5, minCommands: 10, maxCommands: 1000, wallets: 200, bursting: false, lastBurst: `the load generator is not reachable (${errorText(e)})` };
  }
};

// ---- chaos runs ------------------------------------------------------------------------------------------------------------------------------------------------

type LogEntry = { at: string; text: string; ok: boolean };
const run = { running: false, scenarios: [] as string[], minutes: 0, intervalSeconds: 0, holdSeconds: 0, startedAt: null as string | null, endsAt: null as string | null, faults: 0, log: [] as LogEntry[] };
let stopRequested = false;
const note = (text: string, ok = true) => { run.log.push({ at: now(), text, ok }); if (run.log.length > 200) run.log.shift(); annotate(text, [ok ? "ok" : "problem"]); };

const pickRandom = <T>(xs: ReadonlyArray<T>): T | undefined => xs[Math.floor(Math.random() * xs.length)];
const deletePod = (name: string) => kubectl(["delete", "pod", name, "--grace-period=0", "--force", "--wait=false"]);
const seconds = (ms: number | null) => (ms === null ? "never (in time)" : `${(ms / 1000).toFixed(1)} s`);

const killLeader = async (module: ModuleName) => {
  const leader = await leaderOf(module);
  if (leader === null) return note(`no pod leads ${module} right now`, false);
  await deletePod(leader);
  const took = await takeoverMs(module, leader, 90_000);
  const next = took === null ? null : await leaderOf(module);
  note(`killed ${leader} (it led ${module}); ${next === null ? "no new leader" : `${next} leads ${module}`} after ${seconds(took)}`, took !== null);
};
const killOf = async (role: "api" | "workers") => {
  const victim = pickRandom((await listPods()).filter((p) => p.role === role && p.phase === "Running"));
  if (victim === undefined) return note(`no running ${role} pod to kill`, false);
  await deletePod(victim.name);
  note(`killed ${victim.name} (${role})`);
};
const rollingWorkers = async () => {
  await kubectl(["rollout", "restart", "deployment/wallet-workers"]);
  await kubectl(["rollout", "status", "deployment/wallet-workers", "--timeout=180s"], 200_000);
  note("rolling update of the workers finished");
};
const partitionLeader = async (holdSeconds: number) => {
  const pods = await listPods();
  const leader = await leaderOf("views", pods);
  if (leader === null) return note("no pod leads views right now", false);
  const clusterIp = (await kubectl(["get", "service", "postgres", "-o", "jsonpath={.spec.clusterIP}"])).trim();
  const postgresIp = pods.find((p) => p.role === "postgres")?.ip ?? "";
  const ips = [clusterIp, postgresIp].filter((ip) => ip !== "");
  const rules = ips.flatMap((ip) => [`iptables -A OUTPUT -d ${ip} -j DROP`, `iptables -A INPUT -s ${ip} -j DROP`]).join(" && ");
  const debug = (command: string) => kubectl(["debug", leader, "--image", NETSHOOT, "--profile=netadmin", "--target=wallet", "--quiet", "--", "sh", "-c", command], 120_000);
  await debug(rules);
  note(`cut ${leader} from Postgres for ${holdSeconds} s (packets dropped, the connection is not reset)`);
  const took = await takeoverMs("views", leader, holdSeconds * 1000);
  await sleep(Math.max(0, holdSeconds * 1000 - (took ?? holdSeconds * 1000)));
  await debug("iptables -F INPUT && iptables -F OUTPUT").catch((e) => note(`could not heal ${leader}: ${errorText(e)}`, false));
  note(took === null ? `healed ${leader}; no other pod took over views during the cut` : `healed ${leader}; another pod led views after ${seconds(took)}`, took !== null);
};
const pauseView = async (holdSeconds: number) => {
  const view = pickRandom((await processors()).filter((p) => p.kind === "views" && p.status === "ACTIVE"));
  if (view === undefined) return note("no active view to pause", false);
  await admin("POST", `/admin/processors/views/${encodeURIComponent(view.id)}/pause`);
  note(`paused ${view.id} for ${holdSeconds} s (the other views keep running)`);
  await sleep(holdSeconds * 1000);
  await admin("POST", `/admin/processors/views/${encodeURIComponent(view.id)}/resume`);
  note(`resumed ${view.id}`);
};

const faults: Record<string, (hold: number) => Promise<void>> = {
  "kill-views-leader": () => killLeader("views"),
  "kill-automations-leader": () => killLeader("automations"),
  "kill-outbox-leader": () => killLeader("outbox"),
  "kill-worker": () => killOf("workers"),
  "kill-api": () => killOf("api"),
  "rolling-workers": () => rollingWorkers(),
  "partition-leader": (hold) => partitionLeader(hold),
  "pause-view": (hold) => pauseView(hold)
};

const interruptibleSleep = async (ms: number) => { const end = Date.now() + ms; while (Date.now() < end && !stopRequested) await sleep(250); };

const startRun = (request: StartRun): string | null => {
  if (run.running) return "a run is already going";
  if (verify.running || resetting) return "wait for the verification or the reset to finish";
  const unknown = request.scenarios.filter((s) => !(s in faults));
  if (request.scenarios.length === 0 || unknown.length > 0) return unknown.length > 0 ? `unknown scenario: ${unknown[0]}` : "choose at least one scenario";
  if (!(request.minutes >= 1 && request.minutes <= 240)) return "minutes must be from 1 to 240";
  if (!(request.intervalSeconds >= 5 && request.intervalSeconds <= 600)) return "the interval must be from 5 to 600 seconds";
  if (!(request.holdSeconds >= 5 && request.holdSeconds <= 300)) return "the hold must be from 5 to 300 seconds";
  stopRequested = false;
  Object.assign(run, {
    running: true, scenarios: [...request.scenarios], minutes: request.minutes, intervalSeconds: request.intervalSeconds, holdSeconds: request.holdSeconds,
    startedAt: now(), endsAt: new Date(Date.now() + request.minutes * 60_000).toISOString(), faults: 0, log: []
  });
  note(`run started: ${request.scenarios.join(", ")} for ${request.minutes} min, a fault every ${request.intervalSeconds} s`);
  void (async () => {
    try {
      const endMs = Date.parse(run.endsAt!);
      while (!stopRequested && Date.now() < endMs) {
        const id = pickRandom(request.scenarios)!;
        note(`fault: ${scenarios.find((s) => s.id === id)?.label ?? id}`);
        try { await faults[id]!(request.holdSeconds); } catch (e) { note(`${id} failed: ${errorText(e)}`, false); }
        run.faults++;
        await interruptibleSleep(request.intervalSeconds * 1000);
      }
    } finally {
      run.running = false;
      note(stopRequested ? "run stopped" : "run finished");
      if (request.verifyAfter) startVerify();
    }
  })();
  return null;
};

// ---- verification --------------------------------------------------------------------------------------------------------------------------------------------

const verify = { running: false, step: "", result: null as Schema.Schema.Type<typeof Verification> | null };

const startVerify = (): string | null => {
  if (verify.running) return "a verification is already going";
  if (resetting) return "wait for the reset to finish";
  verify.running = true;
  verify.result = null;
  void (async () => {
    const started = Date.now();
    const wasRunning = (await loadStatus()).running;
    try {
      verify.step = "pausing the load";
      if (wasRunning) await loadCall("POST", "/config", { running: false }).catch(() => {});
      // a burst can take minutes to be answered when commands wait on each other (deadlocks), so give it ten
      for (let i = 0; i < 1200 && (await loadStatus()).bursting; i++) { verify.step = "waiting for the last burst to be answered"; await sleep(500); }
      verify.step = "waiting for the processors to catch up";
      let caughtUp = false;
      for (let i = 0; i < 360 && !caughtUp; i++) {
        const list = await processors().catch(() => []);
        caughtUp = list.length > 0 && list.every((p) => p.status === "ACTIVE" && (p.pendingEvents ?? 1) === 0);
        if (!caughtUp) await sleep(1000);
      }
      verify.step = "checking the data";
      const checks: Check[] = [];
      const list = await processors().catch(() => []);
      const unhealthy = list.filter((p) => p.status !== "ACTIVE" || (p.pendingEvents ?? 1) !== 0);
      // one reading decides both the verdict and the words
      const healthy = list.length > 0 && unhealthy.length === 0;
      checks.push({ name: "The processors are running and caught up", info: false, ok: healthy, detail: healthy ? `${list.length} processors ACTIVE with nothing waiting` : list.length === 0 ? "the admin API did not answer" : `still behind after waiting: ${unhealthy.map((p) => `${p.id} (${p.status}, ${p.pendingEvents ?? "?"} waiting)`).join("; ")}` });
      const leaders = await withDb(async (c) => (await c.query(
        `SELECT ((classid::bigint << 32) | objid::bigint)::text AS key, count(*)::int AS holders FROM pg_locks WHERE locktype = 'advisory' AND granted GROUP BY 1`)).rows as Array<{ key: string; holders: number }>);
      const holders = (module: ModuleName) => leaders.find((l) => l.key === LOCKS[module])?.holders ?? 0;
      checks.push({ name: "Exactly one pod leads each module", info: false, ok: (["views", "automations", "outbox"] as const).every((m) => holders(m) === 1), detail: `views ${holders("views")}, automations ${holders("automations")}, outbox ${holders("outbox")} holders of the lock` });
      checks.push(...(await withDb((c) => dataChecks(c))));
      const pods = await listPods();
      const notReady = pods.filter((p) => (p.role === "api" || p.role === "workers") && !p.ready);
      checks.push({ name: "The API and worker pods are ready", info: false, ok: notReady.length === 0, detail: notReady.length === 0 ? `${pods.filter((p) => p.role === "api" || p.role === "workers").length} pods ready` : `not ready: ${notReady.map((p) => p.name).join(", ")}` });
      verify.result = { at: now(), ok: checks.every((c) => c.info || c.ok), waitedSeconds: Math.round((Date.now() - started) / 1000), checks };
    } catch (e) {
      verify.result = { at: now(), ok: false, waitedSeconds: Math.round((Date.now() - started) / 1000), checks: [{ name: "The verification ran", info: false, ok: false, detail: errorText(e) }] };
    } finally {
      if (wasRunning) {
        // say so if the load cannot be started again: a paused load that nobody knows about is how a test goes quiet
        await loadCall("POST", "/config", { running: true }).catch((e) => verify.result?.checks && (verify.result = { ...verify.result, checks: [...verify.result.checks, { name: "The load was started again", info: false, ok: false, detail: errorText(e) }], ok: false }));
      }
      verify.running = false;
      verify.step = "";
    }
  })();
  return null;
};

// ---- emptying the database ---------------------------------------------------------------------------------------------------------------------------------

let resetting = false;
const resetDatabase = (): string | null => {
  if (run.running) return "stop the run first";
  if (verify.running) return "wait for the verification to finish";
  if (resetting) return "a reset is already going";
  resetting = true;
  void (async () => {
    const wasRunning = (await loadStatus()).running;
    try {
      note("reset: pausing the load");
      if (wasRunning) await loadCall("POST", "/config", { running: false }).catch(() => {});
      for (let i = 0; i < 1200 && (await loadStatus()).bursting; i++) await sleep(500);
      // the workers go first, so nothing reads or writes the log while it is emptied; the API has nothing in flight
      await kubectl(["scale", "deployment/wallet-workers", "--replicas=0"]);
      for (let i = 0; i < 60 && (await listPods()).some((p) => p.role === "workers"); i++) await sleep(1000);
      const tables = await withDb(async (c) => {
        const names = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND (tablename LIKE 'crablet\\_%' OR tablename LIKE 'wallet\\_%')`)).rows.map((r: { tablename: string }) => `"${r.tablename}"`);
        await c.query(`TRUNCATE ${names.join(", ")} RESTART IDENTITY CASCADE`);
        return names.length;
      });
      await kubectl(["scale", "deployment/wallet-workers", "--replicas=2"]);
      await kubectl(["rollout", "status", "deployment/wallet-workers", "--timeout=180s"], 200_000);
      await loadCall("POST", "/reset").catch(() => {});
      run.log = [];
      verify.result = null;
      note(`reset: ${tables} tables emptied (the log, the commands, the views and the processors' progress); the workers are back and the load starts with new wallets`);
    } catch (e) {
      note(`reset failed: ${errorText(e)}`, false);
    } finally {
      if (wasRunning) await loadCall("POST", "/config", { running: true }).catch(() => {});
      resetting = false;
    }
  })();
  return null;
};

// ---- the HTTP surface ---------------------------------------------------------------------------------------------------------------------------------------

// The pulse: commands and events per second over the last few seconds (from the counts in the database), and how far behind the processors are (read from the admin API in the background,
// so a saturated API slows this page's state by nothing).
const samples: Array<{ at: number; commands: number; events: number }> = [];
let behind: { pending: number | null; seconds: number | null } = { pending: null, seconds: null };
setInterval(() => {
  void (admin("GET", "/admin/processors") as Promise<{ processors: Array<{ pendingEvents: number | null; oldestPendingSeconds: number | null }> }>)
    .then((r) => { behind = { pending: r.processors.reduce((n, p) => n + (p.pendingEvents ?? 0), 0), seconds: r.processors.reduce((m, p) => Math.max(m, p.oldestPendingSeconds ?? 0), 0) }; })
    .catch(() => { behind = { pending: null, seconds: null }; });
}, 4000);
const pulseOf = (commands: number, events: number) => {
  const at = Date.now();
  samples.push({ at, commands, events });
  while (samples.length > 2 && at - samples[0]!.at > 12_000) samples.shift();
  const first = samples[0]!;
  const seconds = (at - first.at) / 1000;
  const rate = (now_: number, then: number) => (seconds >= 1.5 ? Math.max(0, (now_ - then) / seconds) : 0);
  return { commandsPerSecond: rate(commands, first.commands), eventsPerSecond: rate(events, first.events), pendingEvents: behind.pending, behindSeconds: behind.seconds };
};

const snapshot = async (): Promise<typeof State.Type> => {
  const pods = await listPods();
  const [leaders, load, counts] = await Promise.all([
    allLeaders(pods).catch(() => ({ views: null, automations: null, outbox: null })),
    loadStatus(),
    withDb(async (c) => (await c.query("SELECT (SELECT count(*) FROM crablet_commands)::float AS commands, (SELECT count(*) FROM crablet_events)::float AS events")).rows[0] as { commands: number; events: number }).catch(() => ({ commands: 0, events: 0 }))
  ]);
  return {
    now: now(),
    context: CONTEXT,
    pods: pods.map(({ ip: _ip, ...pod }) => pod),
    leaders,
    run: { ...run, scenarios: [...run.scenarios], log: [...run.log] },
    verify: { running: verify.running || resetting, step: resetting ? "emptying the database" : verify.step, result: verify.result },
    load,
    pulse: pulseOf(counts.commands, counts.events),
    commands: counts.commands,
    events: counts.events
  };
};

const readBody = (req: import("node:http").IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; if (text.length > 65_536) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(text === "" ? {} : JSON.parse(text)); } catch { reject(new Error("not JSON")); } });
    req.on("error", reject);
  });

const ack = (problem: string | null, okText: string) => Schema.encodeSync(Ack)(problem === null ? { ok: true, text: okText } : { ok: false, text: problem });

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  try {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/api/state") return send(200, Schema.encodeSync(State)(await snapshot()));
    if (req.method === "GET" && url === "/api/scenarios") return send(200, scenarios);
    if (req.method !== "POST") return send(404, { error: "not found" });
    const body = await readBody(req);
    if (url === "/api/run") return send(200, ack(startRun(Schema.decodeUnknownSync(StartRun)(body)), "run started"));
    if (url === "/api/run/stop") { stopRequested = true; return send(200, ack(run.running ? null : "no run is going", "stopping after the current fault")); }
    if (url === "/api/kill") {
      const { pod } = Schema.decodeUnknownSync(KillPod)(body);
      const target = (await listPods()).find((p) => p.name === pod);
      if (target === undefined) return send(200, ack(`no pod ${pod}`, ""));
      if (target.role !== "api" && target.role !== "workers") return send(200, ack(`the lab does not kill ${target.role} pods from here`, ""));
      await deletePod(pod);
      note(`killed ${pod} (by hand)`);
      return send(200, ack(null, `deleted ${pod}`));
    }
    if (url === "/api/load") {
      const set = Schema.decodeUnknownSync(SetLoad)(body);
      const status = await loadCall("POST", "/config", { running: set.on, intervalSeconds: set.intervalSeconds, minCommands: set.minCommands, maxCommands: set.maxCommands, wallets: set.wallets });
      return send(200, ack(null, status["running"] === true ? "the load is running" : "the load is paused"));
    }
    if (url === "/api/verify") return send(200, ack(startVerify(), "verifying"));
    if (url === "/api/reset") {
      const { confirm } = Schema.decodeUnknownSync(ResetDatabase)(body);
      return send(200, ack(confirm ? resetDatabase() : "the reset was not confirmed", "emptying the database"));
    }
    send(404, { error: "not found" });
  } catch (e) {
    send(200, { ok: false, text: errorText(e) });
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`chaos lab server on http://127.0.0.1:${PORT} (kubectl context ${CONTEXT}); the page: cd examples/chaos-ui && bun run dev`));
process.on("SIGINT", () => { forward?.kill(); process.exit(0); });
