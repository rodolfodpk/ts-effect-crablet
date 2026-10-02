// Browser-safety checks for modules that a browser page imports (an API definition, a set of contracts). CI never builds a UI, so without
// this a server-only import added somewhere below such a module would break or poison the browser bundle unnoticed. It bundles the entry for
// the browser IN-PROCESS (about 80 ms, Bun's bundler) and reports what was pulled in, so a unit test can forbid modules by pattern.
//
// Bun-only (it uses `Bun.build`): use it from `bun test` unit tests, not from the Node integration tests.
import path from "node:path";

// What must never be reachable from a browser: Node built-ins, the Postgres client and HTTP server, and the packages that run on a server.
export const serverOnly: ReadonlyArray<RegExp> = [
  /^node:/,
  /sql-pg/,
  /[\\/]node_modules[\\/](\.bun[\\/])?pg[@\\/]/,
  /platform-node/,
  /packages[\\/](event-poller|views|outbox|automations|db-migrations|test-support)[\\/]/
];

// The machinery that RUNS a command's decision. A module that declares the API from contracts must not reach it.
export const commandPipeline: ReadonlyArray<RegExp> = [
  /packages[\\/]commands[\\/]src[\\/](Command|CommandExecutor|CommandDecision|Model|Event|Crablet)\.ts$/
];

export interface Bundled {
  // false when the bundler refused to build (Bun throws when a Node-only module cannot be polyfilled for a browser: the failure being guarded)
  readonly built: boolean;
  // every module the bundle reached, including external imports
  readonly reached: ReadonlyArray<string>;
  // the reached modules that match a forbidden pattern
  readonly forbidden: ReadonlyArray<string>;
}

export const bundleForBrowser = async (entry: string, forbidden: ReadonlyArray<RegExp> = serverOnly): Promise<Bundled> => {
  try {
    const result = await Bun.build({ entrypoints: [path.resolve(entry)], target: "browser", metafile: true, logLevel: "silent" } as never);
    const meta = (result as unknown as { metafile?: { inputs: Record<string, { imports?: ReadonlyArray<{ path: string; external?: boolean }> }> } }).metafile;
    const reached = new Set<string>(Object.keys(meta?.inputs ?? {}));
    for (const info of Object.values(meta?.inputs ?? {})) for (const imp of info.imports ?? []) if (imp.external) reached.add(imp.path);
    return { built: result.success, reached: [...reached], forbidden: [...reached].filter((p) => forbidden.some((re) => re.test(p))) };
  } catch {
    return { built: false, reached: [], forbidden: [] };
  }
};
