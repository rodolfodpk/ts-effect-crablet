// The tutorial (docs/tutorial/course-enrolment.md) cannot drift from the code it shows: every code block tagged
// `<!-- file: path#region -->` must equal that file's `// #region name` ... `// #endregion name` (compared with the
// common indentation removed), and the files, scripts and URLs the text mentions must exist.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");
const docPath = path.join(root, "docs/tutorial/course-enrolment.md");
const doc = readFileSync(docPath, "utf8");
const packageDir = path.join(root, "examples/course-enrolment-app");

const dedent = (text: string): string => {
  const lines = text.replace(/\s+$/u, "").split("\n").map((l) => l.replace(/\s+$/u, ""));
  const indent = Math.min(...lines.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length));
  return lines.map((l) => l.slice(Math.min(indent, l.length))).join("\n");
};

const region = (file: string, name: string): string => {
  const lines = readFileSync(path.join(root, file), "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === `// #region ${name}`);
  const end = lines.findIndex((l) => l.trim() === `// #endregion ${name}`);
  if (start < 0 || end < start) throw new Error(`${file}: no region "${name}" (// #region ${name} ... // #endregion ${name})`);
  return dedent(lines.slice(start + 1, end).join("\n"));
};

const blocks = [...doc.matchAll(/<!-- file: (\S+?)#(\S+?) -->\n```(\w+)\n([\s\S]*?)\n```/gu)].map((m) => ({
  file: m[1]!,
  name: m[2]!,
  code: dedent(m[4]!)
}));

describe("tutorial: code blocks equal the files they come from", () => {
  test("there are tagged blocks (so removing the tags cannot make this test pass vacuously)", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(10);
  });

  for (const block of blocks) {
    test(`${block.file}#${block.name}`, () => {
      expect(block.code).toBe(region(block.file, block.name));
    });
  }
});

describe("tutorial: what the text points at exists", () => {
  test("relative links resolve to files that exist", () => {
    const links = [...doc.matchAll(/\]\((?!https?:)([^)#\s]+)(?:#[^)]*)?\)/gu)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(5);
    for (const link of links) expect(existsSync(path.resolve(path.dirname(docPath), link)), `broken link: ${link}`).toBe(true);
  });

  test("every `node <script>` runs a file that exists in the package; every `bun test <file>` a file that exists", () => {
    const scripts = [...doc.matchAll(/^(?:[A-Z_]+=\S+ )?node (\S+\.ts)/gmu)].map((m) => m[1]!);
    expect(scripts).toEqual(expect.arrayContaining(["src/migrate.ts", "scripts/step2-postgres.ts", "src/index.ts", "scripts/generate-openapi.ts"]));
    for (const script of scripts) expect(existsSync(path.join(packageDir, script)), `missing script: ${script}`).toBe(true);
    for (const m of doc.matchAll(/^bun test (\S+)/gmu)) expect(existsSync(path.join(root, m[1]!)), `missing test file: ${m[1]}`).toBe(true);
  });

  test("every URL the curl examples call is a route in the checked-in OpenAPI document (or the document / docs page itself)", () => {
    const spec = JSON.parse(readFileSync(path.join(root, "docs/api/course-enrolment-openapi.json"), "utf8")) as { paths: Record<string, unknown> };
    const patterns = Object.keys(spec.paths).map((p) => new RegExp(`^${p.replace(/\{[^}]+\}/gu, "[^/]+")}$`, "u"));
    const urls = [...doc.matchAll(/localhost:8080(\/[^\s'">?]*)/gu)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(8);
    for (const url of urls) {
      if (url === "/openapi.json" || url === "/docs") continue;
      expect(patterns.some((re) => re.test(url)), `not a route in the OpenAPI document: ${url}`).toBe(true);
    }
  });

  test("the command names the tutorial POSTs to are the registered ones", () => {
    const spec = JSON.parse(readFileSync(path.join(root, "docs/api/course-enrolment-openapi.json"), "utf8")) as { paths: Record<string, unknown> };
    const posted = new Set([...doc.matchAll(/localhost:8080\/api\/commands\/(\w+)/gu)].map((m) => m[1]!));
    for (const name of posted) expect(Object.keys(spec.paths)).toContain(`/api/commands/${name}`);
  });
});
