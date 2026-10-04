// A write marker: where in the log one write ended, as one string a client can hold and send back later.
//
// It is the pair a progress cursor compares in (ADR-0012): the transaction that wrote the last event of the write, and that event's
// position. `"<transactionId>:<position>"`, both decimal. A reader that has the marker can ask for a view that has reached it
// (ADR-0015).
//
// The transaction id stays text: it is a Postgres xid8 (up to 2^64 - 1), which a JavaScript number cannot hold. Each marker has exactly
// one spelling (no sign, no leading zeros, no spaces), so two markers are equal when their strings are.
export interface Marker {
  readonly transactionId: string;
  readonly position: bigint;
}

export const formatMarker = (marker: Marker): string => `${marker.transactionId}:${marker.position}`;

const maxXid8 = 18446744073709551615n;
const maxBigint = 9223372036854775807n;
const canonicalNumber = /^(0|[1-9][0-9]*)$/;

// null for anything that is not a marker: not two canonical decimal numbers around one colon, or a number the database cannot hold
// (a transaction id above 2^64 - 1 or a position above 2^63 - 1). Callers answer a 400 for it.
export const parseMarker = (raw: string): Marker | null => {
  const parts = raw.split(":");
  if (parts.length !== 2) return null;
  const [transactionId, position] = parts as [string, string];
  if (!canonicalNumber.test(transactionId) || !canonicalNumber.test(position)) return null;
  if (BigInt(transactionId) > maxXid8 || BigInt(position) > maxBigint) return null;
  return { transactionId, position: BigInt(position) };
};
