// A period a model is scoped by: the unit of time (or any other cycle) after which one statement, shift or ledger page is closed and the next is opened with the state carried forward
// ("closing the books"; docs/plans/period-rollover.md). `Period.month` and its siblings are VALUES, not strings: each carries the type of its fields, and the framework derives from it what
// would otherwise be boilerplate in every model - which period "now" falls in, the tags that scope a model to it, a canonical key, and which period an opening event opened.
//
//     defineModel({ by: "wallet_id", initial })
//       .on(...)
//       .period(Period.month, { opened: StatementOpened, closed: StatementClosed, open: ..., close: ... });
//
// Levels follow UTC unless called with a zone (`Period.day({ timeZone: "America/Sao_Paulo" })`); `Period.week` follows ISO weeks (or weeks from Sunday). An hour is not here yet; `Period.custom` is the way to any other cycle.
import * as Tag from "@crablet/eventstore/Tag";

export type PeriodFields = Readonly<Record<string, number>>;

export interface PeriodSpec<F extends PeriodFields = PeriodFields> {
  // The period `now` falls in.
  readonly fieldsAt: (now: Date) => F;
  // The period an opening event's DATA says it opened, or null if the data does not carry it.
  readonly fieldsOf: (data: unknown) => F | null;
  // A canonical key: equal periods have equal keys, and keys of one level sort in time order ("2026-10", "2026-10-09").
  readonly key: (fields: F) => string;
  // The tag keys that scope a model (and its opening and closing events) to one period.
  readonly tagKeys: ReadonlyArray<string>;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
const num = (data: unknown, field: string): number | null => {
  const v = (data as Record<string, unknown> | null | undefined)?.[field];
  return typeof v === "number" ? v : null;
};
const fieldsFrom = <F extends PeriodFields>(data: unknown, names: ReadonlyArray<keyof F & string>): F | null => {
  const out: Record<string, number> = {};
  for (const name of names) {
    const v = num(data, name);
    if (v === null) return null;
    out[name] = v;
  }
  return out as F;
};

// What a level takes: the zone whose calendar the period follows (an IANA name such as "America/Sao_Paulo"; UTC when omitted).
export interface PeriodOptions {
  readonly timeZone?: string;
}
// A level is a value (the UTC one) that can also be called with options, which gives the level in that zone.
export type PeriodLevel<F extends PeriodFields, O extends PeriodOptions = PeriodOptions> = PeriodSpec<F> & ((options?: O) => PeriodSpec<F>);

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
// The calendar date `now` falls on in a zone. A zone that does not exist is refused here, when the level is defined (Intl throws a RangeError naming it).
const calendarIn = (timeZone: string | undefined): ((now: Date) => CalendarDate) => {
  if (timeZone === undefined || timeZone === "UTC") return (now) => ({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() });
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" });
    formatters.set(timeZone, format);
  }
  const f = format;
  return (now) => {
    const parts = f.formatToParts(now);
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return { year: get("year"), month: get("month"), day: get("day") };
  };
};

const level = <F extends PeriodFields, O extends PeriodOptions>(make: (options: O | undefined) => PeriodSpec<F>): PeriodLevel<F, O> =>
  Object.assign((options?: O) => make(options), make(undefined));

export const year = level<{ readonly year: number }, PeriodOptions>((o) => {
  const calendar = calendarIn(o?.timeZone);
  return {
    fieldsAt: (now) => ({ year: calendar(now).year }),
    fieldsOf: (data) => fieldsFrom(data, ["year"]),
    key: (f) => pad(f.year, 4),
    tagKeys: ["year"]
  };
});

export const month = level<{ readonly year: number; readonly month: number }, PeriodOptions>((o) => {
  const calendar = calendarIn(o?.timeZone);
  return {
    fieldsAt: (now) => {
      const d = calendar(now);
      return { year: d.year, month: d.month };
    },
    fieldsOf: (data) => fieldsFrom(data, ["year", "month"]),
    key: (f) => `${pad(f.year, 4)}-${pad(f.month)}`,
    tagKeys: ["year", "month"]
  };
});

export const day = level<{ readonly year: number; readonly month: number; readonly day: number }, PeriodOptions>((o) => {
  const calendar = calendarIn(o?.timeZone);
  return {
    fieldsAt: (now) => calendar(now),
    fieldsOf: (data) => fieldsFrom(data, ["year", "month", "day"]),
    key: (f) => `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}`,
    tagKeys: ["year", "month", "day"]
  };
});

// Weeks. `startsOn` is "monday" (the default: ISO 8601 weeks) or "sunday". A week belongs to the year that holds most of its days: the year of its fourth day (the Thursday of an ISO week), and its
// number counts weeks from the first one that has four days in that year. So 1 January 2027, a Friday, is still in week 53 of 2026.
export interface WeekOptions extends PeriodOptions {
  readonly startsOn?: "monday" | "sunday";
}
const DAY_MS = 86_400_000;
export const week = level<{ readonly year: number; readonly week: number }, WeekOptions>((o) => {
  const calendar = calendarIn(o?.timeZone);
  const firstDay = o?.startsOn === "sunday" ? 0 : 1;
  return {
    fieldsAt: (now) => {
      const d = calendar(now);
      const today = Date.UTC(d.year, d.month - 1, d.day);
      const back = (new Date(today).getUTCDay() - firstDay + 7) % 7;
      const anchor = new Date(today - back * DAY_MS + 3 * DAY_MS); // the fourth day of the week
      const weekYear = anchor.getUTCFullYear();
      const dayOfYear = Math.round((Date.UTC(weekYear, anchor.getUTCMonth(), anchor.getUTCDate()) - Date.UTC(weekYear, 0, 1)) / DAY_MS);
      return { year: weekYear, week: Math.floor(dayOfYear / 7) + 1 };
    },
    fieldsOf: (data) => fieldsFrom(data, ["year", "week"]),
    key: (f) => `${pad(f.year, 4)}-W${pad(f.week)}`,
    tagKeys: ["year", "week"]
  };
});

// Any other cycle (a fiscal year, a shift): the same four functions the levels above carry.
export const custom = <F extends PeriodFields>(spec: PeriodSpec<F>): PeriodSpec<F> => spec;

export const Period = { year, month, day, week, custom } as const;

export const tagsOf = (spec: PeriodSpec<any>, fields: PeriodFields): ReadonlyArray<Tag.Tag> => spec.tagKeys.map((k) => Tag.of(k, String(fields[k])));
