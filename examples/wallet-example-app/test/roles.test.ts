import { describe, expect, test } from "bun:test";
import { allRoles, hasWorkers, rolesFromEnv } from "../src/roles.ts";

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
