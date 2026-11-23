// The page's client module (`src/api.ts`) is bundled for a browser: it builds its client from the course API definition and reads what a call failed with. It must
// reach nothing that only makes sense on a server, and none of the BEHAVIOR of the commands. CI never builds the UI, so this is what notices a server-only import
// added below it (the API definition itself is checked in course-enrolment-app/test/browser-safe.test.ts).
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { bundleForBrowser, commandPipeline, serverOnly } from "@crablet/test-support/BrowserSafety";

const forbidden = [...serverOnly, ...commandPipeline, /course-enrolment-app[\\/]src[\\/]domain[\\/]Enrolment\.ts$/];

describe("browser safety of the page's client", () => {
  test("api.ts bundles for the browser and reaches nothing server-only", async () => {
    const api = await bundleForBrowser(path.resolve(import.meta.dir, "../src/api.ts"), forbidden);
    expect(api.built).toBe(true);
    expect(api.reached.length).toBeGreaterThan(20); // it really traced the imports (a vacuous pass would reach nothing)
    expect(api.forbidden).toEqual([]);
  });
});
