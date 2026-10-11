// An unattended soak: starts the load and a run of faults through the lab server, samples the system every minute into a JSONL file, verifies the data at the end, and stops everything early
// if the nodes' disk runs low. Needs the lab server (server.ts) and the cluster running.
// The load is steady (10 to maxCommands every intervalSeconds) except for short STRESS windows: at minutes 15, 45, 75, 105, ... for 5 minutes the largest burst is 1000, more than the wallet can take,
// so a backlog builds and has to drain, and the samples show how long that takes. Short, so the storage stays modest (about 35 MB a window).
//   node tools/chaos-ui/server/soak.ts <out.jsonl> [minutes=120] [maxCommands=100] [intervalSeconds=5] [period=$WALLET_PERIOD or month]
// `period` is only written to the log, to label the run: the lab's own deployment decides it (WALLET_PERIOD=minutes:5 node examples/wallet-example-app/lab/lab.ts observe).
import { execFileSync } from "node:child_process";
import { appendFileSync, statfsSync, writeFileSync } from "node:fs";

const [out, minutesArg, maxArg, intervalArg, periodArg] = process.argv.slice(2);
if (out === undefined) { console.error("usage: soak.ts <out.jsonl> [minutes] [maxCommands] [intervalSeconds]"); process.exit(2); }
const minutes = Number(minutesArg ?? 120), maxCommands = Number(maxArg ?? 100), loadInterval = Number(intervalArg ?? 5);
const SERVER = process.env["CHAOS_SERVER_URL"] ?? "http://127.0.0.1:5174";
// The soak stops itself (the run and the load) when ANY of these holds, checked every minute:
const GB = 1024 ** 3;
const MIN_NODE_FREE = 15 * GB; // the disk of the kind nodes (the Docker VM)
const MIN_HOST_FREE = 20 * GB; // the Mac's own disk, which the Docker VM's disk file grows into
const MAX_DATABASE = 5 * GB; // the database with its WAL: about 40 times what a 2-hour soak should write
const MAX_BLIND_SAMPLES = 3; // minutes in a row that the disk could not be read: then it cannot be trusted
const hostFreeBytes = (): number => { const f = statfsSync("/"); return f.bavail * f.bsize; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const call = async (path: string, body?: unknown): Promise<any> => (await fetch(`${SERVER}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const record = (entry: object) => appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

writeFileSync(out, "");
const startedAt = Date.now();
const settings = { intervalSeconds: loadInterval, minCommands: 10, maxCommands, wallets: 200 };
record({ event: "start", minutes, period: periodArg ?? process.env["WALLET_PERIOD"] ?? "month", ...settings });
record({ event: "load", ...(await call("/api/load", { on: true, ...settings })) });
record({
  event: "run",
  ...(await call("/api/run", { scenarios: ["kill-views-leader", "kill-automations-leader", "kill-outbox-leader", "kill-worker", "kill-api", "rolling-workers", "pause-view"], minutes, intervalSeconds: 120, holdSeconds: 20, verifyAfter: true }))
});

const STRESS = { every: 30, offset: 15, length: 5, maxCommands: 1000 };
const stressNow = (minute: number) => minute >= STRESS.offset && (minute - STRESS.offset) % STRESS.every < STRESS.length;
let stressing = false;
let blind = 0;
let silent = 0;
let stoppedFor: string | null = null;
let last = { commands: 0, events: 0, at: Date.now() };
while (stoppedFor === null) {
  await sleep(60_000);
  let s: any;
  try { s = await call("/api/state"); silent = 0; } catch (e) {
    record({ event: "no-answer", error: String(e) });
    // the lab server is gone, so nothing here can pause the load, and the load generator is a pod that keeps writing: stop it directly
    if (++silent >= 3) {
      try { execFileSync("kubectl", ["--context", "kind-crablet-lab", "scale", "deployment/loadgen", "--replicas=0"], { timeout: 30_000 }); stoppedFor = "the lab server stopped answering for 3 minutes; the load generator was scaled to zero"; }
      catch (e2) { stoppedFor = `the lab server stopped answering and the load generator could not be stopped: ${String(e2)}`; }
    }
    continue;
  }
  const minuteNow = Math.round((Date.now() - startedAt) / 60_000);
  if (stressNow(minuteNow) !== stressing && s.run.running) {
    stressing = !stressing;
    record({ event: stressing ? "stress-start" : "stress-end", ...(await call("/api/load", { on: true, ...settings, maxCommands: stressing ? STRESS.maxCommands : maxCommands })) });
  }
  const dt = (Date.now() - last.at) / 1000;
  const sample = {
    event: "sample",
    minute: minuteNow,
    stress: stressing,
    commands: s.commands, events: s.events,
    commandsPerSecond: +((s.commands - last.commands) / dt).toFixed(1),
    behindSeconds: s.pulse.behindSeconds, pendingEvents: s.pulse.pendingEvents,
    leaders: s.leaders,
    pods: s.pods.filter((p: any) => p.role === "api" || p.role === "workers").map((p: any) => ({ name: p.name, ready: p.ready, restarts: p.restarts })),
    databaseBytes: s.storage?.databaseBytes ?? null, walBytes: s.storage?.walBytes ?? null, nodeDiskFreeBytes: s.storage?.nodeDiskFreeBytes ?? null, hostFreeBytes: hostFreeBytes(),
    faults: s.run.faults, runRunning: s.run.running, verifying: s.verify.running
  };
  last = { commands: s.commands, events: s.events, at: Date.now() };
  record(sample);
  const hostFree = hostFreeBytes();
  blind = sample.nodeDiskFreeBytes === null || sample.databaseBytes === null ? blind + 1 : 0;
  if (sample.nodeDiskFreeBytes !== null && sample.nodeDiskFreeBytes < MIN_NODE_FREE) stoppedFor = `the nodes' disk has ${(sample.nodeDiskFreeBytes / GB).toFixed(1)} GB free`;
  else if (hostFree < MIN_HOST_FREE) stoppedFor = `the Mac's disk has ${(hostFree / GB).toFixed(1)} GB free`;
  else if (sample.databaseBytes !== null && sample.databaseBytes + (sample.walBytes ?? 0) > MAX_DATABASE) stoppedFor = `the database is ${((sample.databaseBytes + (sample.walBytes ?? 0)) / GB).toFixed(1)} GB with its WAL`;
  else if (blind >= MAX_BLIND_SAMPLES) stoppedFor = `the disk or the database size could not be read for ${blind} minutes`;
  else if (!s.run.running && !s.verify.running && s.verify.result !== null && Date.parse(s.verify.result.at) > startedAt) {
    record({ event: "verification", ...s.verify.result });
    stoppedFor = s.verify.result.ok ? "the run finished and the data verified" : "the run finished and the verification FAILED";
  } else if (Date.now() - startedAt > (minutes + 30) * 60_000) stoppedFor = "it took more than 30 minutes longer than planned";
}
if (!stoppedFor.startsWith("the run finished")) await call("/api/run/stop", {}).catch(() => {});
await call("/api/load", { on: false, ...settings }).catch(() => {});
record({ event: "end", reason: stoppedFor });
console.log(`soak ended: ${stoppedFor}`);
process.exit(stoppedFor === "the run finished and the data verified" ? 0 : 1);
