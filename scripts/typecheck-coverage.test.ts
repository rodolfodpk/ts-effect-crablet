// Every TypeScript file in the repository is type-checked: each one versioned is matched by the `include` of some tsconfig.json, and not by that
// tsconfig's `exclude` (CLAUDE.md, "Type safe", rule 4). `bun run typecheck` runs every tsconfig listed here, so a file none of them include is never
// checked: when this rule came in, 17 were not (diagnostics, the examples' scripts, the lab), and one had kept a field removed long before.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";

const root = path.resolve(import.meta.dir, "..");

interface TsConfig { readonly dir: string; readonly include: ReadonlyArray<string>; readonly exclude: ReadonlyArray<string> }

const versioned = (pattern: string): ReadonlyArray<string> =>
  execFileSync("git", ["ls-files", "--", pattern], { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f !== "");

const tsconfigs: ReadonlyArray<TsConfig> = versioned("*tsconfig.json").map((file) => {
  const json = JSON.parse(readFileSync(path.join(root, file), "utf8")) as { include?: ReadonlyArray<string>; exclude?: ReadonlyArray<string> };
  return { dir: path.dirname(file), include: json.include ?? [], exclude: json.exclude ?? [] };
});

// A path relative to the repository, against a tsconfig's patterns (relative to its own folder). An `exclude` entry without a wildcard is a folder.
const covers = (config: TsConfig, file: string): boolean => {
  const local = config.dir === "." ? file : path.relative(config.dir, file);
  if (local.startsWith("..")) return false;
  const excluded = config.exclude.some((p) => (/[*?]/u.test(p) ? new Glob(p).match(local) : local === p || local.startsWith(`${p}/`)));
  return !excluded && config.include.some((p) => new Glob(p).match(local));
};

// The tsconfigs `bun run typecheck` runs: the root one and every one it names with `--cwd`.
const typecheckScript: string = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts.typecheck;

describe("every TypeScript file is type-checked", () => {
  const files = [...versioned("*.ts"), ...versioned("*.tsx")];

  test("the scan sees the repository (so an empty listing cannot make this pass)", () => {
    expect(tsconfigs.length).toBeGreaterThanOrEqual(4);
    expect(files.length).toBeGreaterThan(300);
  });

  test("the rule tells a covered file from an uncovered one (so a broken matcher cannot make this pass)", () => {
    const rootConfig = tsconfigs.find((c) => c.dir === ".")!;
    expect(covers(rootConfig, "packages/commands/src/Command.ts")).toBe(true);
    expect(covers(rootConfig, "packages/commands/somewhere-new/Thing.ts")).toBe(false);
    expect(covers(rootConfig, "tools/chaos-ui/src/main.ts")).toBe(false); // excluded: it has its own tsconfig
  });

  test("each versioned .ts and .tsx file is included by a tsconfig", () => {
    expect(files.filter((f) => !tsconfigs.some((c) => covers(c, f)))).toEqual([]);
  });

  test("`bun run typecheck` runs every tsconfig", () => {
    for (const config of tsconfigs.filter((c) => c.dir !== ".")) expect(typecheckScript).toContain(`--cwd ${config.dir} typecheck`);
  });
});
