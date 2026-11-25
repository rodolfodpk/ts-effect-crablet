import { Schema } from "effect";
import { opaqueCursor } from "./OpaqueCursor.ts";

// Keyset paging for the wallet's transaction list: the page size and the cursor.

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

const maxBigInt = 9223372036854775807n;
// What Postgres prints for a timestamptz: `2026-10-03 12:00:00.123456+00`, with optional fractional seconds and a `+hh` or `+hh:mm` offset.
const timestamptzText = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
// A BIGINT, as decimal text: what `$n::bigint` accepts.
const bigintText = Schema.makeFilter<string>((s) => (/^[0-9]+$/.test(s) && BigInt(s) <= maxBigInt) || "a non-negative BIGINT, as decimal text");

// The key on the wire: `{ o, p, t }`, as JSON, base64url (`OpaqueCursor`).
const TransactionCursorKey = Schema.Struct({
  occurredAt: Schema.String.check(Schema.isPattern(timestamptzText)),
  eventPosition: Schema.String.check(bigintText),
  transactionId: Schema.String
}).pipe(Schema.encodeKeys({ occurredAt: "o", eventPosition: "p", transactionId: "t" }));

const transactionCursor = opaqueCursor<TransactionCursorKey>(TransactionCursorKey, 1024);
export const encodeTransactionCursor = transactionCursor.encode;
// null for anything that is not a cursor this module made.
export const decodeTransactionCursor = transactionCursor.decode;
