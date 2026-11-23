// The type-escape ratchet (scripts/type-escapes.ts): no workspace has more escapes than its package.json records, and none has fewer either, so a
// removed escape lowers the record (`bun run type-escapes:baseline`) and the debt can only go down.
import { describe, expect, test } from "bun:test";
import { escapesIn, workspaces } from "./type-escapes.ts";

describe("type escapes", () => {
  const all = workspaces();

  test("the scan sees the workspaces (so an empty listing cannot make this pass)", () => {
    expect(all.length).toBeGreaterThanOrEqual(15);
  });

  test("the counter counts code, and leaves comments, strings and stated reasons out (so a broken counter cannot make this pass)", () => {
    expect(escapesIn("const a = b as unknown as C;\nconst d = e as never;\nconst f: any = g as any;\nh<any>();")).toBe(5);
    expect(escapesIn("// x as never\n/* y as any */\nconst s = \"z as any\";")).toBe(0);
    expect(escapesIn("// type escape: the dynamic group\nconst g = HttpApiBuilder.group as any;")).toBe(0);
    expect(escapesIn("const g = HttpApiBuilder.group as any; // type escape: the dynamic group")).toBe(0);
  });

  // found by review (2026-11-23)
  test("a string that holds // or /* does not hide the code after it", () => {
    expect(escapesIn('const u = fetch("http://x") as any;')).toBe(1);
    expect(escapesIn('const p = "/*" as never;\nconst q = r as never; // */')).toBe(2);
    expect(escapesIn("const t = `a // b` as any;")).toBe(1);
    // a regex literal that holds a quote, or a slash, does not open a string that swallows the lines below
    expect(escapesIn('expect(f(m as never)).toThrow(/the "x" event/);\nconst k = n as never;')).toBe(2);
    expect(escapesIn("const r = a.split(/\\//) as never;\nconst s = b as never;")).toBe(2);
    expect(escapesIn("const half = total / 2 as never;\nconst d = e as never;")).toBe(2);
  });

  test("a reason at the end of a line excuses that line only; a reason on its own line excuses the line below", () => {
    expect(escapesIn("const a = x as any; // type escape: ok\nconst b = y as any;")).toBe(1);
    expect(escapesIn("// type escape: ok\nconst b = y as any;\nconst c = z as any;")).toBe(1);
    expect(escapesIn("  // type escape: indented, alone on its line\n  const b = y as any;")).toBe(0);
  });

  test("every workspace records its counts", () => {
    expect(all.filter((w) => w.recorded === undefined).map((w) => w.dir)).toEqual([]);
  });

  for (const w of all) {
    test(`${w.dir}: no more escapes than recorded, and the record is not stale`, () => {
      expect(w.counts, `${w.dir}: run \`bun run type-escapes:baseline\` only after removing escapes, never to make room for new ones`).toEqual(
        w.recorded ?? { src: -1, test: -1 }
      );
    });
  }
});
