// The wallet's statement period setting (WALLET_PERIOD): month by default, or a slot of N minutes.
import { DateTime } from "effect";
import { describe, expect, test } from "bun:test";
import { Period } from "@crablet/commands/Period";
import { minutesPeriod, periodFromEnv } from "../src/domain/WalletPeriod.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

describe("periodFromEnv", () => {
  test("unset, blank and `month` are the calendar month", () => {
    for (const value of [undefined, "", "  ", "month"]) expect(periodFromEnv(value).tagKeys).toEqual(Period.month.tagKeys);
    expect(periodFromEnv("month").fieldsAt(at("2026-10-31T23:59:00Z"))).toEqual({ year: 2026, month: 10 });
  });

  test("`minutes:N` is a slot of N minutes, scoped by year and bucket", () => {
    const period = periodFromEnv("minutes:5");
    expect(period.tagKeys).toEqual(["year", "bucket"]);
    expect(period.fieldsAt(at("2026-10-11T12:00:00Z"))).toMatchObject({ year: 2026 });
  });

  test("anything else is refused with a message that names the setting", () => {
    for (const bad of ["minutes:0", "minutes:1441", "minutes:abc", "minutes:", "minutes:2.5", "hours:1", "weekly"]) {
      expect(() => periodFromEnv(bad)).toThrow(/WALLET_PERIOD|N from 1 to 1440/);
    }
  });
});

describe("minutesPeriod", () => {
  const five = minutesPeriod(5);

  test("every instant inside one slot is the same period; the next instant is the next period", () => {
    const first = five.fieldsAt(at("2026-10-11T12:00:00.000Z"));
    expect(five.fieldsAt(at("2026-10-11T12:04:59.999Z"))).toEqual(first);
    const next = five.fieldsAt(at("2026-10-11T12:05:00.000Z"));
    expect(next["bucket"]).toBe(first["bucket"]! + 1);
    expect(five.key(first)).toMatch(/^m\d+$/);
    expect(five.key(next)).not.toBe(five.key(first));
  });

  test("slots are aligned to the epoch, so N that divides the hour starts on the clock", () => {
    const bucket = five.fieldsAt(at("2026-10-11T12:05:00.000Z"))["bucket"]!;
    expect(bucket * 5 * 60_000).toBe(Date.parse("2026-10-11T12:05:00.000Z"));
  });

  test("the year is the UTC year of the slot's start: the last slot of a year belongs to it, the next one to the new year", () => {
    expect(five.fieldsAt(at("2026-12-31T23:59:59Z"))["year"]).toBe(2026);
    expect(five.fieldsAt(at("2027-01-01T00:00:00Z"))["year"]).toBe(2027);
  });

  test("an opening event's data says which period it opened, and data without a slot says nothing", () => {
    const fields = five.fieldsAt(at("2026-10-11T12:00:00Z"));
    expect(five.fieldsOf({ walletId: "w", ...fields })).toEqual(fields);
    expect(five.fieldsOf({ walletId: "w", year: 2026, month: 10 })).toBeNull();
    expect(five.fieldsOf(null)).toBeNull();
  });

  test("a bad N is refused", () => {
    for (const n of [0, -1, 1.5, 1441]) expect(() => minutesPeriod(n)).toThrow(/1 to 1440/);
  });
});
