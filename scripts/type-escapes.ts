// Type escapes per workspace, kept from growing (CLAUDE.md, "Type safe", rule 5). An escape is `as unknown as`, `as never`, `as any`, `: any` or `<any>`
// in code (not in a comment). One that must stay says why on its line or the line above, `// type escape: <why>`, and is not counted. Each workspace
// (a package, an example, a tool) records its own counts in its package.json, `crablet.typeEscapes: { src, test }` (`src` is its src/ folder, `test`
// everything else: tests, fixtures, diagnostics, scripts), so the debt belongs to who owns it and no central file has many owners.
//
//     bun scripts/type-escapes.ts            # prints each workspace's counts against its package.json
//     bun scripts/type-escapes.ts --update   # writes the current counts into each package.json (after removing escapes, or to start)
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const skip = new Set(["node_modules", ".git", "dist", "coverage", ".idea", ".claude"]);
const walk = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((name) => {
    if (skip.has(name)) return [];
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

export interface Counts { readonly src: number; readonly test: number }
export interface Workspace { readonly dir: string; readonly packageJson: string; readonly counts: Counts; readonly recorded: Counts | undefined }

const escape = /\bas\s+unknown\s+as\b|\bas\s+never\b|\bas\s+any\b|:\s*any\b|<any>/gu;
const reason = /\/\/\s*type escape:/u;

// The escapes of one file: per line, outside comments, unless the line or the one above says `// type escape:`.
export const escapesIn = (text: string): number => {
  const lines = text.replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, " ")).split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (reason.test(line) || reason.test(lines[i - 1] ?? "")) continue;
    const code = line.replace(/\/\/.*$/u, "").replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/gu, '""');
    count += (code.match(escape) ?? []).length;
  }
  return count;
};

export const workspaces = (): ReadonlyArray<Workspace> =>
  ["packages", "examples", "tools"].flatMap((group) =>
    readdirSync(path.join(root, group))
      .map((name) => path.join(group, name))
      .filter((dir) => existsSync(path.join(root, dir, "package.json")))
      .map((dir) => {
        const packageJson = path.join(root, dir, "package.json");
        const files = walk(path.join(root, dir)).filter((f) => /\.(ts|tsx)$/u.test(f));
        const isSrc = (f: string) => path.relative(path.join(root, dir), f).startsWith(`src${path.sep}`);
        const sum = (fs: ReadonlyArray<string>) => fs.reduce((n, f) => n + escapesIn(readFileSync(f, "utf8")), 0);
        const recorded = (JSON.parse(readFileSync(packageJson, "utf8")) as { crablet?: { typeEscapes?: Counts } }).crablet?.typeEscapes;
        return { dir, packageJson, counts: { src: sum(files.filter(isSrc)), test: sum(files.filter((f) => !isSrc(f))) }, recorded };
      })
  );

// The package.json text with `crablet.typeEscapes` set to `counts`, everything else left as it is written (a rewrite through JSON.stringify would
// reformat the rest of the file).
export const withCounts = (text: string, counts: Counts): string => {
  const entry = `"typeEscapes": { "src": ${counts.src}, "test": ${counts.test} }`;
  if (/"typeEscapes":\s*\{[^}]*\}/u.test(text)) return text.replace(/"typeEscapes":\s*\{[^}]*\}/u, entry);
  if (/"crablet":\s*\{/u.test(text)) return text.replace(/"crablet":\s*\{(\s*)/u, (_m, space: string) => `"crablet": {${space}${entry},${space}`);
  return text.replace(/\n\}\s*$/u, `,\n  "crablet": { ${entry} }\n}\n`);
};

if (import.meta.main) {
  const update = process.argv.includes("--update");
  for (const w of workspaces()) {
    if (update) writeFileSync(w.packageJson, withCounts(readFileSync(w.packageJson, "utf8"), w.counts));
    const was = w.recorded === undefined ? "none" : `${w.recorded.src}/${w.recorded.test}`;
    console.log(`${w.dir.padEnd(36)} src ${String(w.counts.src).padStart(3)}  test ${String(w.counts.test).padStart(3)}  (recorded ${was})`);
  }
}
