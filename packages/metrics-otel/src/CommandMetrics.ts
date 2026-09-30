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

// Incremented each time a command is re-run after a `Conflict` (stale decision), tagged by command_type.
export const conflictRetries = Metric.counter("crablet.command.conflict_retries");
