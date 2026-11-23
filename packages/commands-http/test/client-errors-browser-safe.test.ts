// `ClientErrors.ts` is imported by pages that are bundled for a browser (a Foldkit page reading what a typed client failed with), and CI never builds a UI. It
// imports nothing, so the bundle reaches this file and no other: no Node module, no driver, nothing of the server.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { bundleForBrowser } from "@crablet/test-support/BrowserSafety";

describe("browser safety of ClientErrors", () => {
  test("its bundle reaches only itself", async () => {
    const bundled = await bundleForBrowser(path.resolve(import.meta.dir, "../src/ClientErrors.ts"));
    expect(bundled.built).toBe(true);
    expect(bundled.forbidden).toEqual([]);
    expect(bundled.reached.map((p) => path.basename(p))).toEqual(["ClientErrors.ts"]);
  });
});
