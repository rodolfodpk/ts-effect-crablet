import { describe, expect, test } from "bun:test";
import { allRoles, hasWorkers } from "../src/roles.ts";
import { rolesFromValue } from "./support/roles.ts";

describe("WALLET_ROLES", () => {
  test("blank or all means every role, so nothing changes for a deployment that never sets it", () => {
    expect(rolesFromValue("")).toEqual(allRoles);
    expect(rolesFromValue("  ")).toEqual(allRoles);
    expect(rolesFromValue("all")).toEqual(allRoles);
  });

  test("a list picks exactly those roles, ignoring spaces and repeats", () => {
    expect([...rolesFromValue("api")]).toEqual(["api"]);
    expect([...rolesFromValue(" views , automations ,views")].sort()).toEqual(["automations", "views"]);
    expect(rolesFromValue("api,all")).toEqual(allRoles);
  });

  test("an unknown role stops the start-up, naming it", () => {
    for (const bad of ["web", "API"]) expect(() => rolesFromValue(bad), bad).toThrow(`"${bad}" is not a role`);
  });

  test("an empty entry stops the start-up, naming the variable", () => {
    for (const bad of ["views,", ",api", "views,,api"]) expect(() => rolesFromValue(bad), bad).toThrow('["WALLET"]["ROLES"]');
  });

  test("only api means no workers", () => {
    expect(hasWorkers(rolesFromValue("api"))).toBe(false);
    expect(hasWorkers(rolesFromValue("outbox"))).toBe(true);
    expect(hasWorkers(allRoles)).toBe(true);
  });
});
