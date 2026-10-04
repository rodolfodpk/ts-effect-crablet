// Keyset paging for the wallet's transaction list: the page size and the cursor, as plain functions.

export const defaultPageSize = 20;
export const maxPageSize = 100;

// `?limit=`: absent means the default; anything but a whole number from 1 to the maximum is invalid (null).
export const parseLimit = (raw: string | undefined): number | null => {
  if (raw === undefined) return defaultPageSize;
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= maxPageSize ? n : null;
};

// Where the last row of a page sits in the list's order: (occurred_at, event_position, transaction_id), newest first.
//
// - `occurredAt` is the column printed by Postgres (`occurred_at::text`), not a JavaScript Date: a Date keeps milliseconds and the column keeps
//   microseconds, so a cursor made from a Date could land on or before a row it has already served.
// - `eventPosition` is the log position of the event the row came from, a decimal string (the column is a BIGINT).
// - `transactionId` is the wallet view's own id (not the log's transaction id). The view's key is (transaction_id, event_position), so
//   two rows can share a timestamp and an event position and only this tells them apart.
export interface TransactionCursorKey {
  readonly occurredAt: string;
  readonly eventPosition: string;
  readonly transactionId: string;
}

// The cursor is opaque to clients: the key as JSON, base64url, so it is safe in a query string.
export const encodeTransactionCursor = (key: TransactionCursorKey): string =>
  Buffer.from(JSON.stringify({ o: key.occurredAt, p: key.eventPosition, t: key.transactionId })).toString("base64url");

const maxCursorLength = 1024;
const maxBigInt = 9223372036854775807n;
// What Postgres prints for a timestamptz: `2026-10-03 12:00:00.123456+00`, with optional fractional seconds and a `+hh` or `+hh:mm` offset.
const timestamptzText = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

// null for anything that is not a cursor this module made. Each part is checked against what the SQL will cast it to, so a forged or
// corrupted cursor is a 400 for the caller and never a Postgres cast error (a 500).
export const decodeTransactionCursor = (raw: string): TransactionCursorKey | null => {
  if (raw === "" || raw.length > maxCursorLength || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { o, p, t } = parsed as { o?: unknown; p?: unknown; t?: unknown };
  if (typeof o !== "string" || !timestamptzText.test(o)) return null;
  if (typeof p !== "string" || !/^[0-9]+$/.test(p) || BigInt(p) > maxBigInt) return null;
  if (typeof t !== "string") return null;
  return { occurredAt: o, eventPosition: p, transactionId: t };
};
