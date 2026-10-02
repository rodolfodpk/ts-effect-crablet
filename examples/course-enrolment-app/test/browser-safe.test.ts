// The browser-safety guard. `src/CourseApi.ts` is the API DEFINITION a browser page imports (examples/course-enrolment-ui builds its
// client from it), so it must reach nothing that only makes sense on a server: no Node module, no database driver, no poller.
// CI never builds the UI, so without this a server-only import added anywhere in the domain would break (or poison) the
// browser bundle unnoticed until someone ran `vite build`.
//
// It bundles the file for the browser in-process (about 80 ms) and checks what was pulled in. The negative control is the
// server entry (CourseApp.ts), which must NOT pass: if the check ever stopped detecting, that test would fail.
import { describe, expect, test } from "bun:test";
import path from "node:path";

const src = path.resolve(import.meta.dir, "../src");

// What must never be reachable from the browser: Node built-ins, the Postgres client and HTTP server, and the packages that run on a server.
const SERVER_ONLY = [
  /^node:/,
  /sql-pg/,
  /[\\/]node_modules[\\/](\.bun[\\/])?pg[@\\/]/,
  /platform-node/,
  /packages[\\/](event-poller|views|outbox|automations|db-migrations|test-support)[\\/]/,
  // the BEHAVIOR of the commands: the domain module that decides, and the pipeline that runs a decision
  /[\\/]domain[\\/]Enrolment\.ts$/,
  /packages[\\/]commands[\\/]src[\\/](Command|CommandExecutor|CommandDecision|Model|Event|Crablet)\.ts$/
];

interface Bundled {
  readonly built: boolean;
  readonly reached: ReadonlyArray<string>;
  readonly forbidden: ReadonlyArray<string>;
}

const bundle = async (entry: string): Promise<Bundled> => {
  try {
    const result = await Bun.build({ entrypoints: [path.join(src, entry)], target: "browser", metafile: true, logLevel: "silent" } as never);
    const meta = (result as unknown as { metafile?: { inputs: Record<string, { imports?: ReadonlyArray<{ path: string; external?: boolean }> }> } }).metafile;
    const reached = new Set<string>(Object.keys(meta?.inputs ?? {}));
    for (const info of Object.values(meta?.inputs ?? {})) for (const imp of info.imports ?? []) if (imp.external) reached.add(imp.path);
    return { built: result.success, reached: [...reached], forbidden: [...reached].filter((p) => SERVER_ONLY.some((re) => re.test(p))) };
  } catch {
    // Bun throws when a Node-only module cannot be polyfilled for the browser: that is exactly the failure being guarded
    return { built: false, reached: [], forbidden: [] };
  }
};

describe("browser safety of the API definition", () => {
  test("CourseApi.ts bundles for the browser and reaches nothing server-only", async () => {
    const api = await bundle("CourseApi.ts");
    expect(api.built).toBe(true);
    expect(api.reached.length).toBeGreaterThan(20); // it really traced the imports (a vacuous pass would reach nothing)
    expect(api.forbidden).toEqual([]);
  });

  test("negative control: the server entry (CourseApp.ts) does not pass the same check", async () => {
    const server = await bundle("CourseApp.ts");
    expect(server.built === false || server.forbidden.length > 0).toBe(true);
  });
});
