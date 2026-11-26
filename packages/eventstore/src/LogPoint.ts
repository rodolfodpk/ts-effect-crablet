// A point in the log: an event named by the transaction that appended it and its position, compared in that order (ADR-0012). `position` comes
// from a sequence on insert and `transactionId` from the transaction, and the two can come in opposite orders, so neither alone is an order.
//
// One type under three names: a command's write marker (`Marker`, where its write ended), a processor's progress (`ProgressCursor`, in
// `@crablet/modules`, kept equal to this one by a type test in `@crablet/event-poller`), and, as text, a paged read's `Cursor`. One spelling as
// text, `"<transactionId>:<position>"`, both decimal, with no sign, leading zeros or spaces, so two points are equal when their texts are.
//
// The transaction id stays text: it is a Postgres xid8 (up to 2^64 - 1), which a JavaScript number cannot hold.
export interface LogPoint {
  readonly transactionId: string;
  readonly position: bigint;
}

// Before the first event.
export const zero: LogPoint = { transactionId: "0", position: 0n };

export const of = (transactionId: string, position: bigint): LogPoint => ({ transactionId, position });

// (transactionId, position) lexicographic order; transaction ids are compared numerically.
export const compare = (a: LogPoint, b: LogPoint): -1 | 0 | 1 => {
  const xa = BigInt(a.transactionId);
  const xb = BigInt(b.transactionId);
  // Stryker disable next-line EqualityOperator: the two differ here, so `<` and `<=` answer the same.
  if (xa !== xb) return xa < xb ? -1 : 1;
  // Stryker disable next-line EqualityOperator: as above.
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return 0;
};

export const format = (point: LogPoint): string => `${point.transactionId}:${point.position}`;

const maxXid8 = 18446744073709551615n;
const maxBigint = 9223372036854775807n;
const canonicalNumber = /^(0|[1-9][0-9]*)$/;

// null for anything that is not a point: not two canonical decimal numbers around one colon, or a number the database cannot hold (a transaction
// id above 2^64 - 1 or a position above 2^63 - 1). Callers answer a 400 for it.
export const parse = (text: string): LogPoint | null => {
  const parts = text.split(":");
  if (parts.length !== 2) return null;
  const [transactionId, position] = parts as [string, string];
  if (!canonicalNumber.test(transactionId) || !canonicalNumber.test(position)) return null;
  if (BigInt(transactionId) > maxXid8 || BigInt(position) > maxBigint) return null;
  return { transactionId, position: BigInt(position) };
};
