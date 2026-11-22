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
