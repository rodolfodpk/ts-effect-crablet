// A period a model is scoped by: the unit of time (or any other cycle) after which one statement, shift or ledger page is closed and the next is opened with the state carried forward
// ("closing the books"; docs/plans/period-rollover.md). `Period.month` and its siblings are VALUES, not strings: each carries the type of its fields, and the framework derives from it what
// would otherwise be boilerplate in every model - which period "now" falls in, the tags that scope a model to it, a canonical key, and which period an opening event opened.
//
//     defineModel({ by: "wallet_id", initial })
//       .on(...)
//       .period(Period.month, { opened: StatementOpened, closed: StatementClosed, open: ..., close: ... });
//
// Levels are UTC. A zone, a week and an hour are not here yet; `Period.custom` is the way to any other cycle.
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

export const year: PeriodSpec<{ readonly year: number }> = {
  fieldsAt: (now) => ({ year: now.getUTCFullYear() }),
  fieldsOf: (data) => fieldsFrom(data, ["year"]),
  key: (f) => pad(f.year, 4),
  tagKeys: ["year"]
};

export const month: PeriodSpec<{ readonly year: number; readonly month: number }> = {
  fieldsAt: (now) => ({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }),
  fieldsOf: (data) => fieldsFrom(data, ["year", "month"]),
  key: (f) => `${pad(f.year, 4)}-${pad(f.month)}`,
  tagKeys: ["year", "month"]
};

export const day: PeriodSpec<{ readonly year: number; readonly month: number; readonly day: number }> = {
  fieldsAt: (now) => ({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() }),
  fieldsOf: (data) => fieldsFrom(data, ["year", "month", "day"]),
  key: (f) => `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}`,
  tagKeys: ["year", "month", "day"]
};

// Any other cycle (a fiscal year, a shift): the same four functions the levels above carry.
export const custom = <F extends PeriodFields>(spec: PeriodSpec<F>): PeriodSpec<F> => spec;

export const Period = { year, month, day, custom } as const;

export const tagsOf = (spec: PeriodSpec<any>, fields: PeriodFields): ReadonlyArray<Tag.Tag> => spec.tagKeys.map((k) => Tag.of(k, String(fields[k])));
