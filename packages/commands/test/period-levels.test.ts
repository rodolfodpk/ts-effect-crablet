// The levels of Period.ts: UTC by default, a time zone on request, ISO weeks. Pure functions of an instant: no database, no scenario.
import { describe, expect, test } from "bun:test";
import { Period } from "../src/Period.ts";

const at = (iso: string) => new Date(iso);

describe("UTC levels (the default, a value)", () => {
  test("year, month and day at an instant", () => {
    expect(Period.year.fieldsAt(at("2026-10-09T23:59:59Z"))).toEqual({ year: 2026 });
    expect(Period.month.fieldsAt(at("2026-10-09T23:59:59Z"))).toEqual({ year: 2026, month: 10 });
    expect(Period.day.fieldsAt(at("2026-10-09T23:59:59Z"))).toEqual({ year: 2026, month: 10, day: 9 });
    expect(Period.day.key({ year: 2026, month: 10, day: 9 })).toBe("2026-10-09");
  });

  test("keys sort in time order", () => {
    const keys = ["2025-12-31", "2026-01-02", "2026-01-10", "2026-10-09"].map((d) => Period.day.key(Period.day.fieldsAt(at(`${d}T12:00:00Z`))));
    expect([...keys].sort()).toEqual(keys);
  });
});

describe("a time zone", () => {
  const saoPaulo = Period.day({ timeZone: "America/Sao_Paulo" });
  const newYork = Period.day({ timeZone: "America/New_York" });

  test("a day turns at local midnight, not at UTC midnight", () => {
    expect(saoPaulo.fieldsAt(at("2026-10-10T02:30:00Z"))).toEqual({ year: 2026, month: 10, day: 9 }); // 23:30 in Sao Paulo
    expect(saoPaulo.fieldsAt(at("2026-10-10T03:00:00Z"))).toEqual({ year: 2026, month: 10, day: 10 }); // 00:00 in Sao Paulo
    expect(Period.day.fieldsAt(at("2026-10-10T02:30:00Z"))).toEqual({ year: 2026, month: 10, day: 10 }); // the default is UTC
  });

  test("daylight saving: the day that ends it is 25 hours long, the day that starts it is 23", () => {
    // New York leaves daylight time on 2026-11-01 at 06:00 UTC: local 1 November runs from 04:00 UTC to 05:00 UTC the next day
    expect(newYork.fieldsAt(at("2026-11-01T03:59:00Z")).day).toBe(31);
    expect(newYork.fieldsAt(at("2026-11-01T04:00:00Z")).day).toBe(1);
    expect(newYork.fieldsAt(at("2026-11-02T04:59:00Z")).day).toBe(1);
    expect(newYork.fieldsAt(at("2026-11-02T05:00:00Z")).day).toBe(2);
    // and starts it on 2026-03-08: local 8 March runs from 05:00 UTC to 04:00 UTC the next day
    expect(newYork.fieldsAt(at("2026-03-08T04:59:00Z")).day).toBe(7);
    expect(newYork.fieldsAt(at("2026-03-08T05:00:00Z")).day).toBe(8);
    expect(newYork.fieldsAt(at("2026-03-09T03:59:00Z")).day).toBe(8);
    expect(newYork.fieldsAt(at("2026-03-09T04:00:00Z")).day).toBe(9);
  });

  test("a month and a year in a zone turn at the zone's midnight too", () => {
    expect(Period.month({ timeZone: "Asia/Tokyo" }).fieldsAt(at("2026-09-30T15:00:00Z"))).toEqual({ year: 2026, month: 10 }); // 00:00 on 1 October in Tokyo
    expect(Period.year({ timeZone: "Pacific/Auckland" }).fieldsAt(at("2026-12-31T11:00:00Z"))).toEqual({ year: 2027 }); // 00:00 on 1 January in Auckland (UTC+13)
  });

  test("a level with a zone reads the period back from an event's data like the default one", () => {
    expect(saoPaulo.fieldsOf({ year: 2026, month: 10, day: 9, other: 1 })).toEqual({ year: 2026, month: 10, day: 9 });
    expect(saoPaulo.fieldsOf({ year: 2026 })).toBeNull();
    expect(saoPaulo.tagKeys).toEqual(["year", "month", "day"]);
  });

  test("a zone that does not exist is refused when the level is defined", () => {
    expect(() => Period.day({ timeZone: "Mars/Olympus" })).toThrow(/Mars\/Olympus/);
  });
});

describe("weeks (the week belongs to the year that holds most of its days)", () => {
  const week = (iso: string, options?: { startsOn?: "monday" | "sunday"; timeZone?: string }) => Period.week(options).fieldsAt(at(iso));

  test("ISO weeks: weeks start on Monday and week 1 is the one with the first Thursday", () => {
    expect(week("2026-10-09T12:00:00Z")).toEqual({ year: 2026, week: 41 }); // a Friday
    expect(week("2026-12-31T12:00:00Z")).toEqual({ year: 2026, week: 53 }); // 2026 has 53 weeks
    expect(week("2027-01-01T12:00:00Z")).toEqual({ year: 2026, week: 53 }); // 1 January 2027 is a Friday: still 2026's last week
    expect(week("2027-01-04T12:00:00Z")).toEqual({ year: 2027, week: 1 });
    expect(week("2024-12-30T12:00:00Z")).toEqual({ year: 2025, week: 1 }); // a Monday in December that belongs to the next year
    expect(week("2021-01-03T12:00:00Z")).toEqual({ year: 2020, week: 53 }); // the Sunday that ends 2020's week 53
  });

  test("Monday 00:00 starts a week, Sunday 23:59 ends the one before", () => {
    expect(week("2026-10-11T23:59:00Z").week).toBe(41); // Sunday
    expect(week("2026-10-12T00:00:00Z").week).toBe(42); // Monday
  });

  test("a week that starts on Sunday", () => {
    const sun = { startsOn: "sunday" as const };
    expect(week("2026-10-10T12:00:00Z", sun)).toEqual(week("2026-10-04T12:00:00Z", sun)); // Saturday and the Sunday before are one week
    expect(week("2026-10-11T12:00:00Z", sun).week).toBe(week("2026-10-10T12:00:00Z", sun).week + 1); // the next Sunday starts the next
  });

  test("a week in a zone, and its key, tags and way back", () => {
    const w = Period.week({ timeZone: "America/Sao_Paulo" });
    expect(w.fieldsAt(at("2026-10-12T02:30:00Z"))).toEqual({ year: 2026, week: 41 }); // still Sunday 23:30 in Sao Paulo
    expect(w.fieldsAt(at("2026-10-12T03:00:00Z"))).toEqual({ year: 2026, week: 42 });
    expect(w.key({ year: 2026, week: 7 })).toBe("2026-W07");
    expect(w.tagKeys).toEqual(["year", "week"]);
    expect(w.fieldsOf({ year: 2026, week: 7 })).toEqual({ year: 2026, week: 7 });
  });

  test("week keys sort in time order across a year", () => {
    const keys = ["2026-09-28", "2026-12-28", "2027-01-04", "2027-06-01"].map((d) => Period.week().key(Period.week().fieldsAt(at(`${d}T12:00:00Z`))));
    expect([...keys].sort()).toEqual(keys);
  });
});
