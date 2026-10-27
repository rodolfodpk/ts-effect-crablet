import { describe, expect, test } from "bun:test";
import * as ProgressCursor from "../src/ProgressCursor.ts";

describe("ProgressCursor.compare", () => {
  test("by transaction id, as numbers; then by position within one transaction; equal is 0", () => {
    const at = ProgressCursor.of;
    expect(ProgressCursor.compare(at("9", 50n), at("10", 1n))).toBe(-1);
    expect(ProgressCursor.compare(at("10", 1n), at("9", 50n))).toBe(1);
    expect(ProgressCursor.compare(at("10", 1n), at("10", 2n))).toBe(-1);
    expect(ProgressCursor.compare(at("10", 2n), at("10", 1n))).toBe(1);
    expect(ProgressCursor.compare(at("10", 2n), at("10", 2n))).toBe(0);
  });
});
