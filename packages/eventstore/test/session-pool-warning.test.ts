import { describe, expect, test } from "bun:test";
import { sessionPoolWarning } from "../src/SessionClients.ts";

// What a process keeps in its session pool for good: one connection per module that leads (a reserved one), one per LISTEN (the modules' wake-ups, and the views' progress hub
// where the api runs). It depends on the roles the process runs, so whoever builds the layer says how many; the layer does not guess.
describe("sessionPoolWarning", () => {
  test("a pool at least as big as what the process holds says nothing", () => {
    expect(sessionPoolWarning(7, 7)).toBeNull();
    expect(sessionPoolWarning(10, 7)).toBeNull();
    expect(sessionPoolWarning(2, 2)).toBeNull();
    expect(sessionPoolWarning(1, 1)).toBeNull();
  });

  test("a smaller pool names both numbers and what happens", () => {
    const warning = sessionPoolWarning(5, 7)!;
    expect(warning).toContain("5");
    expect(warning).toContain("7");
    expect(warning).toMatch(/wait/);
  });

  test("with no number given there is nothing to compare, so it says nothing (an api pod keeps 1, a worker 2: no fixed minimum fits every role)", () => {
    expect(sessionPoolWarning(1, undefined)).toBeNull();
    expect(sessionPoolWarning(undefined, 7)).toBeNull();
  });
});
