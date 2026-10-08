import { describe, expect, test } from "bun:test";
import { poolSizeFromEnv } from "../src/poolSize.ts";

describe("WALLET_DB_POOL", () => {
  test("unset or blank means the library's default (undefined), so nothing changes for a deployment that never sets it", () => {
    expect(poolSizeFromEnv(undefined)).toBeUndefined();
    expect(poolSizeFromEnv("")).toBeUndefined();
    expect(poolSizeFromEnv("   ")).toBeUndefined();
  });

  test("a whole number of 1 or more is the size", () => {
    expect(poolSizeFromEnv("1")).toBe(1);
    expect(poolSizeFromEnv("25")).toBe(25);
    expect(poolSizeFromEnv(" 8 ")).toBe(8);
  });

  test("anything else stops the start-up with a message that names the variable and the value", () => {
    for (const bad of ["0", "-3", "2.5", "ten", "1e1x", "NaN"]) {
      expect(() => poolSizeFromEnv(bad), bad).toThrow(`WALLET_DB_POOL must be a whole number of 1 or more, got "${bad}"`);
    }
  });
});
