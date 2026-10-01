// How far a processor has read: a point in the log in (transaction_id, position) order.
//
// Not a bare position: `position` is taken from a sequence when a row is inserted and `transaction_id` is the
// xid of the inserting transaction, and the two can come in opposite orders. A cursor on the position alone can
// move past a row that commits later with a LOWER position and so skip it for ever. Events are fetched in
// (transaction_id, position) order, bounded by the snapshot's xmin, and a row that appears after a fetch always
// sorts after everything fetched, so this cursor cannot skip one (see docs/plans/poller-cursor-fix.md).
export interface ProgressCursor {
  readonly transactionId: string;
  readonly position: bigint;
}

export const zero: ProgressCursor = { transactionId: "0", position: 0n };

export const of = (transactionId: string, position: bigint): ProgressCursor => ({ transactionId, position });

// The cursor just after `event`: the point to resume from once it has been handled.
export const after = (event: { readonly transactionId: string; readonly position: bigint }): ProgressCursor => ({
  transactionId: event.transactionId,
  position: event.position
});

// (transactionId, position) lexicographic order; transaction ids are compared numerically.
export const compare = (a: ProgressCursor, b: ProgressCursor): -1 | 0 | 1 => {
  const xa = BigInt(a.transactionId);
  const xb = BigInt(b.transactionId);
  if (xa !== xb) return xa < xb ? -1 : 1;
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return 0;
};
