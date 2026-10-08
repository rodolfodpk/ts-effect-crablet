// Puts the wallet API under a steady, mixed load so the dashboard has something to show: opens wallets, then deposits, withdraws and transfers at a given rate,
// with some commands that fail on purpose (a withdrawal larger than the balance, a deposit to a wallet that does not exist).
//   node examples/wallet-example-app/scripts/load.ts [--url http://localhost:8080] [--seconds 120] [--rate 20] [--wallets 25]
// Prints how many requests got each status at the end.
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
};
const url = arg("url", "http://localhost:8080").replace(/\/$/, "");
const seconds = Number(arg("seconds", "120"));
const rate = Number(arg("rate", "20"));
const walletCount = Number(arg("wallets", "25"));

const statuses = new Map<string, number>();
const post = async (command: string, body: unknown): Promise<void> => {
  const key = `${command} ${await fetch(`${url}/api/commands/${command}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => String(r.status), () => "unreachable")}`;
  statuses.set(key, (statuses.get(key) ?? 0) + 1);
};

const run = crypto.randomUUID().slice(0, 8);
const wallets = Array.from({ length: walletCount }, (_, i) => `load-${run}-${i}`);
const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(Math.random() * xs.length)]!;
const id = (): string => crypto.randomUUID();

const once = (): Promise<void> => {
  const roll = Math.random();
  const walletId = pick(wallets);
  if (roll < 0.45) return post("deposit", { depositId: id(), walletId, amount: 1 + Math.floor(Math.random() * 100), description: "load" });
  if (roll < 0.65) return post("withdraw", { withdrawalId: id(), walletId, amount: 1 + Math.floor(Math.random() * 50), description: "load" });
  if (roll < 0.85) {
    const to = pick(wallets.filter((w) => w !== walletId));
    return post("transfer_money", { transferId: id(), fromWalletId: walletId, toWalletId: to, amount: 1 + Math.floor(Math.random() * 30), description: "load" });
  }
  if (roll < 0.95) return post("withdraw", { withdrawalId: id(), walletId, amount: 1_000_000, description: "too much, on purpose" });
  return post("deposit", { depositId: id(), walletId: `missing-${id()}`, amount: 5, description: "no such wallet, on purpose" });
};

console.log(`opening ${walletCount} wallets at ${url}`);
await Promise.all(wallets.map((walletId) => post("open_wallet", { walletId, owner: "load", initialBalance: 1_000 })));
console.log(`load: ${rate} commands a second for ${seconds} s`);
for (let s = 0; s < seconds; s++) {
  const started = Date.now();
  await Promise.all(Array.from({ length: rate }, once));
  await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - started))));
}
console.log([...statuses].sort().map(([k, n]) => `${k}: ${n}`).join("\n"));
