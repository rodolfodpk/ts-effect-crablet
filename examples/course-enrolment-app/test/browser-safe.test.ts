// The browser-safety guard. `src/CourseApi.ts` is the API DEFINITION a browser page imports (examples/course-enrolment-ui builds its
// client from it), so it must reach nothing that only makes sense on a server: no Node module, no database driver, no poller, and none of
// the BEHAVIOR of the commands (the domain module that decides, the pipeline that runs a decision). CI never builds the UI, so without this a
// server-only import added anywhere below it would break (or poison) the browser bundle unnoticed until someone ran `vite build`.
//
// The negative control is the server entry (CourseApp.ts), which must NOT pass: if the check ever stopped detecting, that test would fail.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { bundleForBrowser, commandPipeline, serverOnly } from "@crablet/test-support/BrowserSafety";

const src = path.resolve(import.meta.dir, "../src");
const forbidden = [...serverOnly, ...commandPipeline, /[\\/]domain[\\/]Enrolment\.ts$/];

describe("browser safety of the API definition", () => {
  test("CourseApi.ts bundles for the browser and reaches nothing server-only", async () => {
    const api = await bundleForBrowser(path.join(src, "CourseApi.ts"), forbidden);
    expect(api.built).toBe(true);
    expect(api.reached.length).toBeGreaterThan(20); // it really traced the imports (a vacuous pass would reach nothing)
    expect(api.forbidden).toEqual([]);
  });

  test("negative control: the server entry (CourseApp.ts) does not pass the same check", async () => {
    const server = await bundleForBrowser(path.join(src, "CourseApp.ts"), forbidden);
    expect(server.built === false || server.forbidden.length > 0).toBe(true);
  });
});
