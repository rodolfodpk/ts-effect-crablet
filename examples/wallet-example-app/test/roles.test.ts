import { describe, expect, test } from "bun:test";
import { allRoles, hasWorkers, rolesFromEnv, sessionConnectionsHeld } from "../src/roles.ts";

describe("WALLET_ROLES", () => {
  test("unset or blank means every role, so nothing changes for a deployment that never sets it", () => {
    expect(rolesFromEnv(undefined)).toEqual(allRoles);
    expect(rolesFromEnv("")).toEqual(allRoles);
    expect(rolesFromEnv("  ")).toEqual(allRoles);
    expect(rolesFromEnv("all")).toEqual(allRoles);
  });

  test("a list picks exactly those roles, ignoring spaces and repeats", () => {
    expect([...rolesFromEnv("api")]).toEqual(["api"]);
    expect([...rolesFromEnv(" views , automations ,views")].sort()).toEqual(["automations", "views"]);
    expect(rolesFromEnv("api,all")).toEqual(allRoles);
  });

  test("an unknown or empty entry stops the start-up with a message that names the variable and the value", () => {
    for (const bad of ["web", "views,", ",api", "views,,api", "API"]) {
      expect(() => rolesFromEnv(bad), bad).toThrow(`WALLET_ROLES must be a comma-separated list of api, views, automations, outbox or all, got "${bad}"`);
    }
  });

  test("only api means no workers", () => {
    expect(hasWorkers(rolesFromEnv("api"))).toBe(false);
    expect(hasWorkers(rolesFromEnv("outbox"))).toBe(true);
    expect(hasWorkers(allRoles)).toBe(true);
  });
});

// What a process keeps in the session pool for good (docs/guides/run-in-production.md), measured idle with a pool large enough not to be the limit: the three workers and the api, 7 (3 leader
// locks, 4 LISTEN); the three workers alone, 6; views alone, 2; the api alone, 1.
describe("sessionConnectionsHeld", () => {
  test("is what the roles keep for good: 2 per worker role (its leader lock and its LISTEN) and 1 for the api (the views' progress hub)", () => {
    expect(sessionConnectionsHeld(allRoles)).toBe(7);
    expect(sessionConnectionsHeld(rolesFromEnv("views,automations,outbox"))).toBe(6);
    expect(sessionConnectionsHeld(rolesFromEnv("views"))).toBe(2);
    expect(sessionConnectionsHeld(rolesFromEnv("outbox"))).toBe(2);
    expect(sessionConnectionsHeld(rolesFromEnv("api"))).toBe(1);
    expect(sessionConnectionsHeld(rolesFromEnv("api,views"))).toBe(3);
  });
});

