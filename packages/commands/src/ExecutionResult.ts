// The outcome of running a command: created, or already done (idempotent).
export interface ExecutionResult {
  readonly wasIdempotent: boolean;
  readonly reason: string | null;
  // The log position of the last event this run appended, for waiting until a view has caught up (see
  // @crablet/views/WaitUntilProcessed). `null` when nothing was appended: a repeat of an operation that
  // was already done (its events were written by an earlier run, whose own result carried the position).
  readonly lastPosition: bigint | null;
}

export const created = (lastPosition: bigint): ExecutionResult => ({ wasIdempotent: false, reason: null, lastPosition });
export const idempotent = (reason: string): ExecutionResult => ({ wasIdempotent: true, reason, lastPosition: null });
export const wasCreated = (result: ExecutionResult): boolean => !result.wasIdempotent;
