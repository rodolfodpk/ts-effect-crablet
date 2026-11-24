import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import * as Crablet from "@crablet/app";
import { walletModules } from "../src/processes.ts";
import { rolesFromValue } from "./support/roles.ts";

// What WALLET_ROLES runs, as the entry point reads it: the configuration, then the modules checked against the wallet's declaration.
const run = (value: string) => Effect.runPromiseExit(Crablet.runOf(walletModules, rolesFromValue(value)));
const runs = async (value: string) => {
  const exit = await run(value);
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
  return exit.value;
};

describe("WALLET_ROLES", () => {
  test("blank or all runs every module, so nothing changes for a deployment that never sets it", async () => {
    for (const all of ["", "  ", "all", "api,all"]) expect(await runs(all), all).toBeUndefined();
  });

  test("a list runs exactly those modules, ignoring spaces and repeats; api is the wallet's own role, not a module", async () => {
    expect(await runs("api")).toEqual([]);
    expect(rolesFromValue("api").app.has("api")).toBe(true);
    expect([...((await runs(" views , automations ,views")) ?? [])].sort()).toEqual(["automations", "views"]);
    expect(rolesFromValue("views").app.has("api")).toBe(false);
  });

  test("an unknown role stops the start-up with UnknownRole, naming it and the valid ones", async () => {
    for (const bad of ["web", "API"]) expect(String(await run(bad)), bad).toContain(`"${bad}" is not a role of this process; the roles are api, views, automations, outbox, all`);
  });

  test("an empty entry stops the start-up, naming the variable", () => {
    for (const bad of ["views,", ",api", "views,,api"]) expect(() => rolesFromValue(bad), bad).toThrow('["WALLET"]["ROLES"]');
  });
});
