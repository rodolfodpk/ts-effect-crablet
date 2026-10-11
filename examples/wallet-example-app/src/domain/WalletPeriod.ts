import { Period, type PeriodSpec } from "@crablet/commands/Period";

// The wallet's statement period: a calendar month, or (for the kind lab, so that a period turns while you watch) N minutes. WALLET_PERIOD picks it: unset or `month`, or `minutes:N` with N from 1 to 1440.
//
// It is read once, when the model is defined, and it must not change on a database that already has data: statements written as months carry no `bucket`, so the framework cannot find the period
// of a wallet whose last statement was written the other way ("does not carry the fields of its period") and the next command for that wallet fails. Start a new database to change it.
// Its fields are `year` and `month` (month mode) or `year` and `bucket` (minutes mode: the number of the N-minute slot since the epoch).
export type WalletPeriodFields = { readonly year: number; readonly [field: string]: number };
export type WalletPeriodSpec = PeriodSpec<WalletPeriodFields>;

const MINUTE_MS = 60_000;

// A period of `minutes` minutes: slot number `floor(epochMs / (minutes * 60_000))`. `year` (UTC, of the slot's start) is kept because the statement view has a NOT NULL year column; the slot number alone identifies the period.
export const minutesPeriod = (minutes: number): WalletPeriodSpec => {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error(`a period of N minutes needs N from 1 to 1440, got ${minutes}`);
  return Period.custom<WalletPeriodFields>({
    fieldsAt: (now) => {
      const bucket = Math.floor(now.getTime() / (minutes * MINUTE_MS));
      return { year: new Date(bucket * minutes * MINUTE_MS).getUTCFullYear(), bucket };
    },
    fieldsOf: (data) => {
      const d = data as { readonly year?: unknown; readonly bucket?: unknown } | null | undefined;
      return typeof d?.year === "number" && typeof d.bucket === "number" ? { year: d.year, bucket: d.bucket } : null;
    },
    key: (f) => `m${f.bucket}`,
    tagKeys: ["year", "bucket"]
  });
};

// The month level, as the same spec type: its `key` is only ever called with fields its own `fieldsAt` or `fieldsOf` made (year and month), which the wider type does not know.
const monthPeriod = Period.month as unknown as WalletPeriodSpec;

export const periodFromEnv = (value: string | undefined = process.env["WALLET_PERIOD"]): WalletPeriodSpec => {
  const v = value?.trim();
  if (v === undefined || v === "" || v === "month") return monthPeriod;
  const m = /^minutes:(\d+)$/.exec(v);
  if (m === null) throw new Error(`WALLET_PERIOD must be "month" or "minutes:N" (N from 1 to 1440), got "${value}"`);
  return minutesPeriod(Number(m[1]));
};
