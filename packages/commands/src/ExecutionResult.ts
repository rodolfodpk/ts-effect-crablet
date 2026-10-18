// The outcome of running a command: created, or already done (idempotent).
export interface ExecutionResult {
  readonly wasIdempotent: boolean;
  readonly reason: string | null;
  // The log position of the last event this run appended, for waiting until a view has caught up (the read-your-writes marker). For a repeat
  // ("already done"), where the earlier write is: the latest event its idempotency key matched, or the newest event the decision read, so a
  // client whose first answer was lost still reads its own write (ADR-0034). `null` only when there is nothing to point at (a no-op of a
  // command with no model).
  readonly lastPosition: bigint | null;
  // The id of the transaction that appended them (null exactly when `lastPosition` is). Waiting needs the pair:
  // `position` and `transaction_id` can be taken in opposite orders, and a view's progress is a
  // (transaction_id, position) cursor, so "has it reached my write" compares pairs, not positions.
  readonly lastTransactionId: string | null;
}

export const created = (lastPosition: bigint, lastTransactionId: string): ExecutionResult => ({
  wasIdempotent: false,
  reason: null,
  lastPosition,
  lastTransactionId
});
export const idempotent = (reason: string, marker: { readonly position: bigint; readonly transactionId: string } | null = null): ExecutionResult => ({
  wasIdempotent: true,
  reason,
  lastPosition: marker?.position ?? null,
  lastTransactionId: marker?.transactionId ?? null
});
export const wasCreated = (result: ExecutionResult): boolean => !result.wasIdempotent;
