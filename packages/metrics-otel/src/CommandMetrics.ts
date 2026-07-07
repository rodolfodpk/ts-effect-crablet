import { Metric } from "effect";
import type { OperationMetrics } from "./internal/observe.ts";

export { observe } from "./internal/observe.ts";

// Port of crablet.command.handle / crablet.command.idempotent.duplicate. Tag with
// ("command_type", commandType) at the call site - CommandExecutor.execute's own commandType
// parameter (see the port's design notes on why this had to become an explicit parameter: TS
// commands are plain objects, not classes, so there is no `command.getClass().getSimpleName()`
// equivalent to tag by).
export const handle: OperationMetrics = {
  duration: Metric.timer("crablet.command.handle.duration"),
  successes: Metric.counter("crablet.command.handle.successes"),
  failures: Metric.counter("crablet.command.handle.failures")
};

// Tag with ("command_type", commandType).
export const idempotentDuplicates = Metric.counter("crablet.command.idempotent_duplicates");
