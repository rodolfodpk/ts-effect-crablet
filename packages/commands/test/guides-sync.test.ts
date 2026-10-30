// The guides (every markdown file under docs/guides, in build/ and operate/), the DCB guide and the README cannot drift from the code they show: every block tagged `<!-- file: path#region -->` must equal that
// file's `// #region name` ... `// #endregion name` (compared with the common indentation removed), and the files, links and scripts the text mentions must exist.
// (The tutorial has the same kind of test: examples/course-enrolment-app/test/tutorial-sync.test.ts.)
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");
const guides = (readdirSync(path.join(root, "docs/guides"), { recursive: true }) as Array<string>)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => `docs/guides/${f.split(path.sep).join("/")}`)
  .concat("README.md", "docs/concepts/dcb-guide.md"); // the README's example is the quick start's code; the DCB guide shows the transfer and the enrolment

const dedent = (text: string): string => {
  const lines = text.replace(/\s+$/u, "").split("\n").map((l) => l.replace(/\s+$/u, ""));
  const indent = Math.min(...lines.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length));
  return lines.map((l) => l.slice(Math.min(indent, l.length))).join("\n");
};

const region = (file: string, name: string): string => {
  const lines = readFileSync(path.join(root, file), "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === `// #region ${name}`);
  const end = lines.findIndex((l) => l.trim() === `// #endregion ${name}`);
  if (start < 0 || end < start) throw new Error(`${file}: no region "${name}"`);
  return dedent(lines.slice(start + 1, end).join("\n"));
};

for (const guide of guides) {
  const doc = readFileSync(path.join(root, guide), "utf8");
  const blocks = [...doc.matchAll(/<!-- file: (\S+?)#(\S+?) -->\n```(\w+)\n([\s\S]*?)\n```/gu)].map((m) => ({ file: m[1]!, name: m[2]!, code: dedent(m[4]!) }));

  describe(`${guide}: code blocks equal the files they come from`, () => {
    test("every TypeScript block is tagged (so removing a tag cannot make this test pass vacuously)", () => {
      // A guide with no TypeScript (the index, a runbook) has nothing to check; one that shows code must take all of it from tested files.
      // A short sketch that is not a file is marked `<!-- excerpt -->` on the line before it, so leaving one untested is a visible choice.
      const lines = doc.split("\n");
      const fences = lines.filter((l, i) => /^```(?:ts|typescript)$/u.test(l) && lines[i - 1] !== "<!-- excerpt -->").length;
      expect(blocks.length).toBe(fences);
      if (guide.endsWith("evolving-events.md")) expect(blocks.length).toBeGreaterThanOrEqual(3);
    });
    for (const block of blocks) {
      test(`${block.file}#${block.name}`, () => {
        expect(block.code).toBe(region(block.file, block.name));
      });
    }
  });

  describe(`${guide}: what the text points at exists`, () => {
    test("relative links resolve to files that exist", () => {
      const links = [...doc.matchAll(/\]\((?!https?:)([^)#\s]+)(?:#[^)]*)?\)/gu)].map((m) => m[1]!);
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) expect(existsSync(path.resolve(root, path.dirname(guide), link)), `broken link: ${link}`).toBe(true);
    });

    test("every repository path written in backticks exists (patterns with * are skipped)", () => {
      const paths = [...doc.matchAll(/`((?:packages|examples|tools|docs)\/[^`\s]+)`/gu)].map((m) => m[1]!.replace(/[.,;:]+$/u, "")).filter((p) => !p.includes("*"));
      if (guide.endsWith("evolving-events.md")) expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) expect(existsSync(path.join(root, p)), `missing: ${p}`).toBe(true);
    });
  });
}
