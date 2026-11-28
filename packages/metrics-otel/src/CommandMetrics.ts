import { Metric } from "effect";
import type { OperationMetrics } from "./internal/observe.ts";

export { observe } from "./internal/observe.ts";

// crablet.command.handle / crablet.command.idempotent.duplicate. Tag with
// ("command_type", commandType) at the call site - the defined command's `name`.
export const handle: OperationMetrics = {
  duration: Metric.timer("crablet.command.handle.duration"),
  successes: Metric.counter("crablet.command.handle.successes"),
  failures: Metric.counter("crablet.command.handle.failures")
};

// Tag with ("command_type", commandType).
export const idempotentDuplicates = Metric.counter("crablet.command.idempotent_duplicates");

// A request id reused by a DIFFERENT request (IdempotencyMismatch, ADR-0034): a client bug, or an idempotency key that is too broad. Tag with
// ("command_type", commandType).
export const idempotencyMismatches = Metric.counter("crablet.command.idempotency_mismatches");

// Incremented each time a command is re-run after a `Conflict` (stale decision), tagged by command_type.
export const conflictRetries = Metric.counter("crablet.command.conflict_retries");

// One per execution, after its retries (ADR-0056): what the caller got. By ("command_type", name), ("outcome", created | idempotent | rejected |
// mismatch | conflict | error) and, for rejected and error, ("error", the declared error's tag or the framework's). `handle.*` above counts the
// attempts (how hard the store works); these count the answers. An alert on faults reads outcome="error", never rejected (a business answer).
export const executions = Metric.counter("crablet.command.executions");
export const executionDuration = Metric.timer("crablet.command.execution.duration");
