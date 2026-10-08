import { describe, expect, test } from "bun:test";
import { assertSafeIdentifier } from "../src/internal/identifiers.ts";

// Table and column names are interpolated into SQL (they come from constants, never from a request); this guard stops a typo or an injection from reaching the database.
describe("assertSafeIdentifier", () => {
  test("lower-case words with digits and underscores are allowed", () => {
    for (const ok of ["crablet_view_progress", "_x", "a1", "t_2_x"]) expect(() => assertSafeIdentifier(ok)).not.toThrow();
  });

  test("anything else is refused, with the offending text in the message", () => {
    for (const bad of ["", "1abc", "Upper", "a-b", "a b", "a;DROP TABLE x", 'a"b', "a.b"]) {
      expect(() => assertSafeIdentifier(bad), JSON.stringify(bad)).toThrow(/Unsafe SQL identifier/);
    }
    expect(() => assertSafeIdentifier("a;b")).toThrow('"a;b"');
  });
});
