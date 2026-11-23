import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const dependenciesOf = (pkg: string): ReadonlyArray<string> =>
  Object.keys((JSON.parse(readFileSync(path.join(root, "packages", pkg, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {});

const moduleKinds = ["@crablet/views", "@crablet/automations", "@crablet/outbox", "@crablet/deadlines"];

describe("@crablet/app depends on abstractions (dependency inversion)", () => {
  // Each module describes itself (`Views.module(...)`); the facade knows only the descriptor, so an application of views installs no automations.
  test("@crablet/app depends on no module, and on no HTTP server", () => {
    const deps = dependenciesOf("app");
    expect(deps.filter((d) => moduleKinds.includes(d))).toEqual([]);
    expect(deps.filter((d) => d.startsWith("@effect/platform"))).toEqual([]);
  });

  // The admin API reads the process's modules through the contract, not through the facade or the engine.
  test("@crablet/processors-http depends on the contracts, not on @crablet/app or the event-poller", () => {
    const deps = dependenciesOf("processors-http");
    expect(deps).toContain("@crablet/modules");
    expect(deps.filter((d) => d === "@crablet/app" || d === "@crablet/event-poller")).toEqual([]);
  });

  // The modules implement the contract; none depends on another module or on the facade.
  test("no module depends on another module or on @crablet/app", () => {
    for (const kind of moduleKinds) {
      const deps = dependenciesOf(kind.replace("@crablet/", ""));
      expect({ kind, offending: deps.filter((d) => d === "@crablet/app" || (moduleKinds.includes(d) && d !== kind)) }).toEqual({ kind, offending: [] });
    }
  });
});
