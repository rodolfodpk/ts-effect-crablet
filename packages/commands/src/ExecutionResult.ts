import type { Marker } from "@crablet/eventstore/Marker";

// The outcome of running a command: created, or already done (idempotent).
export interface ExecutionResult {
  readonly wasIdempotent: boolean;
  readonly reason: string | null;
  // Where in the log this write ended: the transaction that appended the events and the position of the last one, for waiting until a view has
  // caught up (the read-your-writes marker; `waitUntilProcessed(view, marker)`, `formatMarker` for a client). Waiting needs the pair: `position`
  // and `transactionId` can be taken in opposite orders, and a view's progress is a (transactionId, position) cursor. For a repeat ("already
  // done"), where the earlier write is: the latest event its idempotency key matched, or the newest event the decision read, so a client whose
  // first answer was lost still reads its own write (ADR-0034). `null` only when there is nothing to point at (a no-op of a command with no model).
  readonly marker: Marker | null;
}

export const created = (marker: Marker): ExecutionResult => ({ wasIdempotent: false, reason: null, marker });
export const idempotent = (reason: string, marker: Marker | null = null): ExecutionResult => ({ wasIdempotent: true, reason, marker });
export const wasCreated = (result: ExecutionResult): boolean => !result.wasIdempotent;
