// The outcome of running a command: created, or already done (idempotent).
export interface ExecutionResult {
  readonly wasIdempotent: boolean;
  readonly reason: string | null;
  // The log position of the last event this run appended, for waiting until a view has caught up (see
  // @crablet/views/WaitUntilProcessed). `null` when nothing was appended: a repeat of an operation that
  // was already done (its events were written by an earlier run, whose own result carried the position).
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
export const idempotent = (reason: string): ExecutionResult => ({
  wasIdempotent: true,
  reason,
  lastPosition: null,
  lastTransactionId: null
});
export const wasCreated = (result: ExecutionResult): boolean => !result.wasIdempotent;
