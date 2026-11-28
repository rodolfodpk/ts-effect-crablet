// The entries a browser page reaches through an API definition (the root, `./ReadsApi`, `./LiveFeedApi`) reach nothing server-only. The server side of the
// same reads (`./ReadsLive`) is the negative control: it must not pass, or the check stopped detecting.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { bundleForBrowser, serverOnly } from "@crablet/test-support/BrowserSafety";

const src = path.resolve(import.meta.dir, "../src");

describe("browser safety of what an endpoint declares", () => {
  for (const entry of ["index.ts", "ReadsApi.ts", "LiveFeedApi.ts"]) {
    test(`${entry} bundles for the browser and reaches nothing server-only`, async () => {
      const bundled = await bundleForBrowser(path.join(src, entry), serverOnly);
      expect(bundled.built).toBe(true);
      expect(bundled.reached.length).toBeGreaterThan(5);
      expect(bundled.forbidden).toEqual([]);
    });
  }

  test("negative control: ReadsLive.ts (the wrapper, which settles the views in the database) does not pass", async () => {
    const server = await bundleForBrowser(path.join(src, "ReadsLive.ts"), serverOnly);
    expect(server.built === false || server.forbidden.length > 0).toBe(true);
  });
});
