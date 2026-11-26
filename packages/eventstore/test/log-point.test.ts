import { describe, expect, test } from "bun:test";
import * as LogPoint from "../src/LogPoint.ts";

describe("LogPoint", () => {
  test("compares by transaction id, as numbers, then by position; equal is 0", () => {
    const at = LogPoint.of;
    expect(LogPoint.compare(at("9", 50n), at("10", 1n))).toBe(-1);
    expect(LogPoint.compare(at("10", 1n), at("9", 50n))).toBe(1);
    expect(LogPoint.compare(at("10", 1n), at("10", 2n))).toBe(-1);
    expect(LogPoint.compare(at("10", 2n), at("10", 1n))).toBe(1);
    expect(LogPoint.compare(at("10", 2n), at("10", 2n))).toBe(0);
  });

  test("has one text form, read back by parse", () => {
    expect(LogPoint.format(LogPoint.of("7421", 98213n))).toBe("7421:98213");
    expect(LogPoint.parse("7421:98213")).toEqual(LogPoint.of("7421", 98213n));
    expect(LogPoint.parse(LogPoint.format(LogPoint.zero))).toEqual(LogPoint.zero);
    expect(LogPoint.parse("7421/98213")).toBeNull();
  });
});
