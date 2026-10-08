// The documentation cannot point at things that are not there: every relative link (and #anchor) in every markdown file must resolve, and the documentation
// paths named in source comments must exist. Historical records (the journal, the plans, the superseded decision record) are exempt from the second check,
// because they correctly name files that have since been removed.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");
const skip = new Set(["node_modules", ".git", "dist", "coverage", ".idea", ".claude"]);

const walk = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((name) => {
    if (skip.has(name)) return [];
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const files = walk(root);
const markdown = files.filter((f) => f.endsWith(".md"));

const anchorsOf = (file: string): Set<string> => {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let inFence = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    const m = !inFence ? /^#{1,6} (.+)$/u.exec(line) : null;
    if (!m) continue;
    const slug = m[1]!.toLowerCase().replace(/[^\w\s-]/gu, "").replace(/\s/gu, "-");
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    out.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return out;
};

describe("documentation links", () => {
  test("there are markdown files to check", () => {
    expect(markdown.length).toBeGreaterThan(40);
  });

  test("every relative link and #anchor in every markdown file resolves", () => {
    const problems: Array<string> = [];
    for (const file of markdown) {
      let inFence = false;
      const text = readFileSync(file, "utf8")
        .split("\n")
        .map((line) => {
          if (line.startsWith("```")) inFence = !inFence;
          return inFence ? "" : line;
        })
        .join("\n");
      for (const m of text.matchAll(/\]\((?!https?:|mailto:)([^)\s]*)\)/gu)) {
        const [target, fragment] = m[1]!.split("#") as [string, string | undefined];
        const resolved = target === "" ? file : path.resolve(path.dirname(file), target);
        if (!existsSync(resolved)) problems.push(`${path.relative(root, file)}: broken link ${m[1]}`);
        else if (fragment && resolved.endsWith(".md") && !anchorsOf(resolved).has(fragment)) problems.push(`${path.relative(root, file)}: no anchor ${m[1]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("documentation paths named in source comments exist", () => {
    const sources = files.filter((f) => /\.(ts|sql)$/u.test(f) && !f.includes(`${path.sep}dist${path.sep}`));
    const problems: Array<string> = [];
    for (const file of sources) {
      for (const m of readFileSync(file, "utf8").matchAll(/(?<![\w/.-])(docs\/[\w./-]+?\.md)\b/gu)) {
        if (!existsSync(path.join(root, m[1]!))) problems.push(`${path.relative(root, file)}: ${m[1]}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
