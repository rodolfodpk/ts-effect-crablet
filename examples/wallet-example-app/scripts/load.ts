// Puts the wallet API under a mixed load so the dashboard has something to show: opens wallets, then deposits, withdraws and transfers, with some commands that fail on purpose
// (a withdrawal larger than the balance, a deposit to a wallet that does not exist).
//   node examples/wallet-example-app/scripts/load.ts [--url http://localhost:8080] [--seconds 120] [--rate 20] [--wallets 25]
// Prints how many requests got each status at the end.
//
// Bursts instead of a steady rate: --burst-every 5 --burst-min 10 --burst-max 1000 sends, every 5 seconds, a uniformly random number of commands from 10 to 1000, all at once, and never
// stops (--seconds is ignored). If a burst takes longer than the interval, the next starts at once.
//
// And it can be steered while it runs: --control-port 9090 serves GET /status and POST /config, so the interval, the range, the number of wallets and start/pause change without restarting
// the process (the kind lab's chaos page does this; see examples/chaos-ui). It binds to all interfaces of the pod, which is what a port-forward needs; run it only where that is fine.
import { createServer } from "node:http";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
};
const url = arg("url", "http://localhost:8080").replace(/\/$/, "");
const seconds = Number(arg("seconds", "120"));
const rate = Number(arg("rate", "20"));
const burstEvery = Number(arg("burst-every", "0"));
const controlPort = Number(arg("control-port", "0"));

const statuses = new Map<string, number>();
const post = async (command: string, body: unknown): Promise<void> => {
  const key = `${command} ${await fetch(`${url}/api/commands/${command}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => String(r.status), () => "failed")}`;
  statuses.set(key, (statuses.get(key) ?? 0) + 1);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// What can be changed while it runs.
const config = {
  running: true,
  intervalSeconds: burstEvery > 0 ? burstEvery : 5,
  minCommands: Number(arg("burst-min", "1")),
  maxCommands: Number(arg("burst-max", "100")),
  wallets: Number(arg("wallets", "25"))
};
let lastBurst: string | null = null;
let bursts = 0;
let inBurst = false; // a burst has been sent and not all answered

let run = crypto.randomUUID().slice(0, 8);
const wallets: string[] = []; // every wallet opened so far; only the first `config.wallets` are used
const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(Math.random() * xs.length)]!;
const id = (): string => crypto.randomUUID();

// The API may still be starting (a pod that has just been created): wait until it answers.
const waitForApi = async (): Promise<void> => {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(`${url}/openapi.json`).then((r) => r.ok, () => false)) return;
    await sleep(2000);
  }
};
// Opens wallets until there are `count` (never closes any: a smaller number just uses fewer).
const ensureWallets = async (count: number): Promise<void> => {
  const fresh: string[] = [];
  while (wallets.length < count) {
    const walletId = `load-${run}-${wallets.length}`;
    wallets.push(walletId);
    fresh.push(walletId);
  }
  await Promise.all(fresh.map((walletId) => post("open_wallet", { walletId, owner: "load", initialBalance: 1_000 })));
};

const once = (): Promise<void> => {
  const roll = Math.random();
  const active = wallets.slice(0, Math.max(2, config.wallets));
  const walletId = pick(active);
  if (roll < 0.45) return post("deposit", { depositId: id(), walletId, amount: 1 + Math.floor(Math.random() * 100), description: "load" });
  if (roll < 0.65) return post("withdraw", { withdrawalId: id(), walletId, amount: 1 + Math.floor(Math.random() * 50), description: "load" });
  if (roll < 0.85) {
    const to = pick(active.filter((w) => w !== walletId));
    return post("transfer_money", { transferId: id(), fromWalletId: walletId, toWalletId: to, amount: 1 + Math.floor(Math.random() * 30), description: "load" });
  }
  if (roll < 0.95) return post("withdraw", { withdrawalId: id(), walletId, amount: 1_000_000, description: "too much, on purpose" });
  return post("deposit", { depositId: id(), walletId: `missing-${id()}`, amount: 5, description: "no such wallet, on purpose" });
};

// ---- the control endpoint -------------------------------------------------------------------------------------------------------------------------------------

const asNumber = (value: unknown, min: number, max: number): number | null => (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null);

// Applies what was sent; returns the problem, or null. Nothing is applied unless every field sent is valid, and min may not exceed max.
const applyConfig = (body: Record<string, unknown>): string | null => {
  const next = { ...config };
  if ("running" in body) {
    if (typeof body["running"] !== "boolean") return "running must be true or false";
    next.running = body["running"];
  }
  const numeric: ReadonlyArray<readonly [keyof typeof config, number, number]> = [["intervalSeconds", 1, 3600], ["minCommands", 1, 5000], ["maxCommands", 1, 5000], ["wallets", 2, 5000]];
  for (const [key, min, max] of numeric) {
    if (!(key in body)) continue;
    const value = asNumber(body[key], min, max);
    if (value === null) return `${key} must be a number from ${min} to ${max}`;
    (next as Record<string, unknown>)[key] = Math.floor(value);
  }
  if (next.minCommands > next.maxCommands) return "minCommands may not be more than maxCommands";
  Object.assign(config, next);
  return null;
};

if (controlPort > 0) {
  createServer((req, res) => {
    const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const status = () => ({ ...config, lastBurst, bursts, inBurst, opened: wallets.length });
    if (req.method === "GET" && req.url === "/status") return reply(200, status());
    if (req.method === "POST" && req.url === "/config") {
      let text = "";
      req.on("data", (chunk) => { text += chunk; if (text.length > 4096) req.destroy(); });
      req.on("end", () => {
        let body: unknown;
        try { body = JSON.parse(text); } catch { return reply(400, { error: "not JSON" }); }
        if (typeof body !== "object" || body === null || Array.isArray(body)) return reply(400, { error: "expected an object" });
        const problem = applyConfig(body as Record<string, unknown>);
        if (problem !== null) return reply(400, { error: problem });
        void ensureWallets(config.wallets);
        return reply(200, status());
      });
      return;
    }
    // Forget the wallets and start with new ones: for after the database was emptied (the old wallets no longer exist).
    if (req.method === "POST" && req.url === "/reset") {
      run = crypto.randomUUID().slice(0, 8);
      wallets.length = 0;
      bursts = 0;
      lastBurst = null;
      return void ensureWallets(config.wallets).then(() => reply(200, status()));
    }
    reply(404, { error: "GET /status, POST /config or POST /reset" });
  }).listen(controlPort, "0.0.0.0", () => console.log(`control: GET /status, POST /config on :${controlPort}`));
}

// ---- the load -------------------------------------------------------------------------------------------------------------------------------------------------

console.log(`opening ${config.wallets} wallets at ${url}`);
await waitForApi();
await ensureWallets(config.wallets);

if (burstEvery > 0) {
  console.log(`bursts: every ${config.intervalSeconds} s, ${config.minCommands} to ${config.maxCommands} commands (uniform), until stopped`);
  for (;;) {
    if (!config.running) { await sleep(300); continue; }
    const started = Date.now();
    const n = config.minCommands + Math.floor(Math.random() * (config.maxCommands - config.minCommands + 1));
    await ensureWallets(config.wallets);
    inBurst = true;
    await Promise.all(Array.from({ length: n }, once));
    inBurst = false;
    bursts++;
    lastBurst = `${n} commands in ${Date.now() - started} ms`;
    console.log(`burst: ${lastBurst}`);
    // wait out the interval in short steps, so a pause, or a new interval, takes effect at once
    while (config.running && Date.now() - started < config.intervalSeconds * 1000) await sleep(200);
  }
}

console.log(`load: ${rate} commands a second for ${seconds} s`);
for (let s = 0; s < seconds; s++) {
  const started = Date.now();
  await Promise.all(Array.from({ length: rate }, once));
  await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - started))));
}
console.log([...statuses].sort().map(([k, n]) => `${k}: ${n}`).join("\n"));
