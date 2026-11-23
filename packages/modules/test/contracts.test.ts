import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isBackedOff } from "@crablet/modules";

const root = path.resolve(import.meta.dir, "..");

describe("@crablet/modules", () => {
  // The contracts are what consumers depend on instead of the engine or a module (dependency inversion): they depend on nothing of the framework.
  test("depends on no @crablet package, in its package.json or in its sources", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith("@crablet/"))).toEqual([]);
    const sources = readdirSync(path.join(root, "src")).map((f) => readFileSync(path.join(root, "src", f), "utf8"));
    expect(sources.filter((text) => /(?:from|import)\s*\(?\s*"@crablet\//u.test(text))).toEqual([]);
  });

  test("isBackedOff: a processor is backed off while it skips polls", () => {
    expect(isBackedOff({ emptyPollCount: 3, currentSkipCounter: 1 })).toBe(true);
    expect(isBackedOff({ emptyPollCount: 3, currentSkipCounter: 0 })).toBe(false);
  });
});
