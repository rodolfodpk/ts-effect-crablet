// The line between a package's API and its plumbing, kept honest. A package lists the entry points that only its siblings build on under `crablet.internal` in its
// package.json (docs/reference/README.md, "Public API and plumbing"). This fails when that list names something that is not an entry point, and when an example's or a
// tool's source, or a page of the documentation, imports one: if an application needs it, it is API, and it comes off the list.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const skip = new Set(["node_modules", ".git", "dist", "coverage", ".idea", ".claude"]);
const walk = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((name) => {
    if (skip.has(name)) return [];
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

interface PackageJson { readonly name: string; readonly exports: Record<string, string>; readonly crablet?: { readonly internal?: ReadonlyArray<string> } }
const packages = readdirSync(path.join(root, "packages"))
  .map((dir) => JSON.parse(readFileSync(path.join(root, "packages", dir, "package.json"), "utf8")) as PackageJson)
  .filter((p) => (p.crablet?.internal?.length ?? 0) > 0);

const rel = (f: string) => path.relative(root, f);
// `text` names the entry point `spec` (an import specifier like @crablet/views/ViewVerdict), and not a longer one that starts with it.
const mentions = (text: string, spec: string): boolean => {
  for (let i = text.indexOf(spec); i >= 0; i = text.indexOf(spec, i + 1)) if (!/[A-Za-z0-9]/u.test(text[i + spec.length] ?? "")) return true;
  return false;
};
// What an application or the documentation is: example and tool code that is not a test or a diagnostic, and the prose documents (not the decision records or the history).
const applicationFiles = [...walk(path.join(root, "examples")), ...walk(path.join(root, "tools"))]
  .filter((f) => /\.(ts|tsx)$/u.test(f) && !/[\\/](test|diagnostics)[\\/]/u.test(f));
const documents = [path.join(root, "README.md"), ...walk(path.join(root, "docs")), ...walk(path.join(root, "packages")).filter((f) => f.endsWith("README.md"))]
  .filter((f) => f.endsWith(".md") && !/[\\/]docs[\\/](adr|history)[\\/]/u.test(f));

describe("public API and plumbing", () => {
  test("at least one package lists internal entry points (so removing the lists cannot make this test pass vacuously)", () => {
    expect(packages.length).toBeGreaterThanOrEqual(3);
  });

  for (const pkg of packages) {
    const internal = pkg.crablet!.internal!;

    test(`${pkg.name}: every internal entry point is an export, and the list is sorted`, () => {
      for (const entry of internal) expect(Object.keys(pkg.exports), `${entry} is not an export of ${pkg.name}`).toContain(entry);
      expect([...internal]).toEqual([...internal].sort());
    });

    test(`${pkg.name}: no application source or document imports an internal entry point`, () => {
      const specifiers = internal.map((entry) => `${pkg.name}/${entry.slice(2)}`);
      const offenders: Array<string> = [];
      for (const file of [...applicationFiles, ...documents]) {
        const text = readFileSync(file, "utf8");
        for (const spec of specifiers) if (mentions(text, spec)) offenders.push(`${rel(file)} imports ${spec}`);
      }
      expect(offenders).toEqual([]);
    });
  }
});
