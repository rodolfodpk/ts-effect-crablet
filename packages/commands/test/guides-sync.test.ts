// The guides (docs/evolving-events.md, docs/snapshots.md) cannot drift from the code they show: every block tagged `<!-- file: path#region -->` must equal that
// file's `// #region name` ... `// #endregion name` (compared with the common indentation removed), and the files, links and scripts the text mentions must exist.
// (The tutorial has the same kind of test: examples/course-enrolment-app/test/tutorial-sync.test.ts.)
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");
const guides = ["docs/evolving-events.md", "docs/snapshots.md"];

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
    test("there are tagged blocks (so removing the tags cannot make this test pass vacuously)", () => {
      expect(blocks.length).toBeGreaterThanOrEqual(3);
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
      const paths = [...doc.matchAll(/`((?:packages|examples|docs)\/[^`\s]+)`/gu)].map((m) => m[1]!.replace(/[.,;:]+$/u, "")).filter((p) => !p.includes("*"));
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) expect(existsSync(path.join(root, p)), `missing: ${p}`).toBe(true);
    });
  });
}
