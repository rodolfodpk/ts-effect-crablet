// Every Mermaid diagram in the documentation parses: GitHub draws the fenced `mermaid` blocks, and one with a syntax error shows as an error box instead
// of the diagram, which nothing else would notice. The diagrams are not checked against the code (CONTRIBUTING.md); this checks only that they draw.
//
// `mermaid.parse` is the parser GitHub's renderer runs, without a browser. Some diagram types sanitise labels through DOMPurify, which binds to a DOM when
// it is loaded, so a jsdom window stands in for one while mermaid loads, and is taken away again: the unit tests share one process, and a global `window`
// makes other libraries (the OpenAPI parser) take themselves for a browser. The version is pinned in package.json; GitHub's own may be newer, and a diagram that only a newer Mermaid accepts fails
// here until the pin is raised.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

const root = path.resolve(import.meta.dir, "..");

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window, document: window.document });
const { default: mermaid } = await import("mermaid").finally(() => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
});

interface Diagram {
  readonly file: string;
  readonly line: number;
  readonly source: string;
}

// The fenced `mermaid` blocks of a markdown text, with the line their fence opens on.
const diagramsIn = (file: string, text: string): ReadonlyArray<Diagram> => {
  const out: Array<Diagram> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})\s*mermaid\s*$/u.exec(lines[i]!);
    if (!open) continue;
    const fence = open[2]!;
    const body: Array<string> = [];
    let j = i + 1;
    while (j < lines.length && !lines[j]!.trim().startsWith(fence)) body.push(lines[j++]!);
    out.push({ file, line: i + 1, source: body.join("\n") });
    i = j;
  }
  return out;
};

// What is wrong with a diagram, or null when it parses.
const problemWith = async (source: string): Promise<string | null> => {
  try {
    await mermaid.parse(source);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

const versioned = execFileSync("git", ["ls-files", "*.md"], { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f !== "");
const diagrams = versioned.flatMap((file) => diagramsIn(file, readFileSync(path.join(root, file), "utf8")));

describe("Mermaid diagrams", () => {
  test("there are diagrams to check", () => {
    expect(diagrams.length).toBeGreaterThan(20);
  });

  test("every diagram in the documentation parses", async () => {
    const problems: Array<string> = [];
    for (const d of diagrams) {
      const problem = await problemWith(d.source);
      if (problem !== null) problems.push(`${d.file}:${d.line}: ${problem}`);
    }
    expect(problems).toEqual([]);
  });

  test("a broken diagram is reported with its file and line", async () => {
    const [d] = diagramsIn("x.md", "text\n\n```mermaid\nflowchart LR\n  A --> \n```\n");
    expect(d).toEqual({ file: "x.md", line: 3, source: "flowchart LR\n  A --> " });
    expect(await problemWith(d!.source)).toMatch(/Parse error/u);
  });

  test("each diagram type the documentation uses is read by the parser, not skipped", async () => {
    // Each type parses when well formed and fails when broken: a type the parser did not know would fail either way, as "No diagram type detected".
    const types: ReadonlyArray<readonly [string, string]> = [
      ["flowchart LR\n  A --> B", "flowchart LR\n  A -->"],
      ["sequenceDiagram\n  A ->> B: hi", "sequenceDiagram\n  A ->>"],
      ["erDiagram\n  A ||--o{ B : has", "erDiagram\n  A ||--o{"],
      ["C4Context\n  Person(a, \"A\")", "C4Context\n  Person(a"],
      ["C4Container\n  Container(a, \"A\", \"TS\")", "C4Container\n  Container(a"],
      ["C4Component\n  Component(a, \"A\", \"TS\")", "C4Component\n  Component(a"]
    ];
    for (const [good, broken] of types) {
      expect(await problemWith(good)).toBeNull();
      const problem = await problemWith(broken);
      expect(problem).not.toBeNull();
      expect(problem).not.toMatch(/No diagram type/u);
    }
  });

  test("a block in a longer fence, or indented in a list, is found; other code blocks are not", () => {
    const text = ["- item", "  ```mermaid", "  flowchart LR", "  A --> B", "  ```", "````mermaid", "flowchart TD", "````", "```ts", "const a = 1;", "```"].join("\n");
    expect(diagramsIn("y.md", text).map((d) => d.line)).toEqual([2, 6]);
  });
});
