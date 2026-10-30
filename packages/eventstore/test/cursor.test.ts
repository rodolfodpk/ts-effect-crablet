import { describe, expect, test } from "bun:test";
import * as Cursor from "../src/Cursor.ts";

describe("Cursor", () => {
  test("is kept as text and read back; anything that is not one is refused", () => {
    const c = Cursor.of("42", 7n);
    expect(Cursor.fromString(Cursor.toString(c))).toBe(c);
    expect(Cursor.parts(c)).toEqual({ transactionId: "42", position: 7n });
    expect(Cursor.parts(Cursor.start)).toEqual({ transactionId: "0", position: 0n });
    for (const bad of ["", "42", "42/", "/7", "a/7", "42/7/1", " 42/7"]) expect(() => Cursor.fromString(bad)).toThrow(/not a cursor/);
  });
});
