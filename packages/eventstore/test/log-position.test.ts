import { describe, expect, test } from "bun:test";
import * as LogPosition from "../src/LogPosition.ts";

const at = (position: bigint, transactionId: string) => LogPosition.of(position, new Date(0), transactionId);
// A cursor with no transaction id at all: what a read with no cursor starts from (eventstore's internal/sql.ts).
const noXid = (position: bigint): LogPosition.LogPosition => ({ position, occurredAt: null, transactionId: null });

describe("LogPosition.of", () => {
  test("refuses a negative position, and takes zero", () => {
    expect(() => LogPosition.of(-1n, new Date(0), "1")).toThrow("LogPosition cannot be negative");
    expect(LogPosition.of(0n, new Date(0), "1").position).toBe(0n);
  });
});

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

  test("by position, not by transaction id, when either id is the zero cursor's \"0\" or missing, even where the two orders disagree", () => {
    // Compared by id, the "0" (or the missing one) would always sort first; by position it is the later one here.
    const oldStyle = at(10n, "0");
    const real = at(5n, "9");
    expect(LogPosition.earliest(oldStyle, real)).toBe(real);
    expect(LogPosition.earliest(real, oldStyle)).toBe(real);
    expect(LogPosition.earliest(noXid(10n), real)).toBe(real);
    expect(LogPosition.earliest(real, noXid(10n))).toBe(real);
    expect(LogPosition.earliest(noXid(3n), noXid(8n)).position).toBe(3n);
  });

  test("equal cursors give the first", () => {
    const a = at(4n, "4");
    expect(LogPosition.earliest(a, at(4n, "4"))).toBe(a);
  });
});

// `latest` is what a repeat answered by its model points at (ADR-0034): the newest event the model read.
describe("LogPosition.latest", () => {
  test("the later of two cursors, in the order `earliest` uses", () => {
    const low = at(900n, "5");
    const high = at(10n, "9");
    expect(LogPosition.latest(low, high)).toBe(high);
    expect(LogPosition.latest(high, low)).toBe(high);
    expect(LogPosition.latest(at(10n, "7"), at(20n, "7")).position).toBe(20n);
    expect(LogPosition.latest(LogPosition.zero(), at(5n, "9")).position).toBe(5n);
  });

  test("equal cursors give the second (earliest gives the first)", () => {
    const a = at(4n, "4");
    const b = at(4n, "4");
    expect(LogPosition.latest(a, b)).toBe(b);
  });
});
