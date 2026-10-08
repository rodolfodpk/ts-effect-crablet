import { describe, expect, test } from "bun:test";
import * as LogPosition from "../src/LogPosition.ts";

const at = (position: bigint, transactionId: string) => LogPosition.of(position, new Date(0), transactionId);

// `earliest` is what a model over several entities takes as its cursor: no member's missed event may sort before it.
describe("LogPosition.earliest", () => {
  test("by transaction id when both carry one and they differ, whatever the positions say", () => {
    const low = at(900n, "5");
    const high = at(10n, "9");
    expect(LogPosition.earliest(low, high)).toBe(low);
    expect(LogPosition.earliest(high, low)).toBe(low);
  });

  test("by position when the transaction ids are the same", () => {
    const a = at(10n, "7");
    const b = at(20n, "7");
    expect(LogPosition.earliest(a, b)).toBe(a);
    expect(LogPosition.earliest(b, a)).toBe(a);
  });

  test("by position when a cursor has no transaction id (the zero cursor, or an old-style position)", () => {
    const zero = LogPosition.zero();
    const real = at(5n, "9");
    expect(LogPosition.earliest(zero, real)).toBe(zero);
    expect(LogPosition.earliest(real, zero)).toBe(zero);
    const early = at(3n, "0");
    const late = at(8n, "0");
    expect(LogPosition.earliest(late, early)).toBe(early);
  });

  test("equal cursors give the first", () => {
    const a = at(4n, "4");
    expect(LogPosition.earliest(a, at(4n, "4"))).toBe(a);
  });
});
