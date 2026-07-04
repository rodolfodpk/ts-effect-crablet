// Port of com.crablet.command.ExecutionResult.
export interface ExecutionResult {
  readonly wasIdempotent: boolean;
  readonly reason: string | null;
}

export const created = (): ExecutionResult => ({ wasIdempotent: false, reason: null });
export const idempotent = (reason: string): ExecutionResult => ({ wasIdempotent: true, reason });
export const wasCreated = (result: ExecutionResult): boolean => !result.wasIdempotent;
