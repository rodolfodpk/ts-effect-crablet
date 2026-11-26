// The browser-safety guard for the wallet's CONTRACTS. `src/shared/WalletContracts.ts` is what the wallet's HTTP API is declared from (and what a
// browser client could import), so it must reach nothing server-only and none of the BEHAVIOR of the commands: the models, the statement periods,
// the slices that decide. Without this a server-only import added below it would only show up when someone tried a browser build.
//
// The negative control is the server entry (WalletApp.ts), which must NOT pass: if the check ever stopped detecting, that test would fail.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { bundleForBrowser, commandPipeline, serverOnly } from "@crablet/test-support/BrowserSafety";

const src = path.resolve(import.meta.dir, "../src");
const forbidden = [
  ...serverOnly,
  ...commandPipeline,
  // every slice (the commands that decide, the views, the automation), and the shared model, periods and events
  /wallet-example-app[\\/]src[\\/]slices[\\/]/,
  /wallet-example-app[\\/]src[\\/]shared[\\/](WalletModel|WalletPeriod|WalletEvents)\.ts$/
];

describe("browser safety of the wallet contracts", () => {
  test("WalletContracts.ts bundles for the browser and reaches nothing server-only", async () => {
    const contracts = await bundleForBrowser(path.join(src, "shared/WalletContracts.ts"), forbidden);
    expect(contracts.built).toBe(true);
    expect(contracts.reached.length).toBeGreaterThan(10);
    expect(contracts.forbidden).toEqual([]);
  });

  test("negative control: the server entry (WalletApp.ts) does not pass the same check", async () => {
    const server = await bundleForBrowser(path.join(src, "WalletApp.ts"), forbidden);
    expect(server.built === false || server.forbidden.length > 0).toBe(true);
  });
});
