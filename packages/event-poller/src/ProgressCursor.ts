import type { ProgressCursor } from "@crablet/modules";
import * as LogPoint from "@crablet/eventstore/LogPoint";

// How far a processor has read: a `LogPoint`, in (transaction_id, position) order.
//
// Not a bare position: `position` is taken from a sequence when a row is inserted and `transaction_id` is the
// xid of the inserting transaction, and the two can come in opposite orders. A cursor on the position alone can
// move past a row that commits later with a LOWER position and so skip it for ever. Events are fetched in
// (transaction_id, position) order, bounded by the snapshot's xmin, and a row that appears after a fetch always
// sorts after everything fetched, so this cursor cannot skip one (see docs/history/plans/poller-cursor-fix.md).
//
// The type is declared in `@crablet/modules`, which depends on no other package; `test/progress-cursor.types.ts` keeps it equal to `LogPoint`.
export type { ProgressCursor };

export const zero: ProgressCursor = LogPoint.zero;

export const of: (transactionId: string, position: bigint) => ProgressCursor = LogPoint.of;

// The cursor just after `event`: the point to resume from once it has been handled.
export const after = (event: { readonly transactionId: string; readonly position: bigint }): ProgressCursor => LogPoint.of(event.transactionId, event.position);

// (transactionId, position) lexicographic order; transaction ids are compared numerically.
export const compare: (a: ProgressCursor, b: ProgressCursor) => -1 | 0 | 1 = LogPoint.compare;
