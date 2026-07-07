import { Metric } from "effect";
import type { OperationMetrics } from "./internal/observe.ts";

export { observe } from "./internal/observe.ts";

// Port of crablet.automation.decide. Tag with ("automation", automationName) at the call site.
export const decide: OperationMetrics = {
  duration: Metric.timer("crablet.automation.decide.duration"),
  successes: Metric.counter("crablet.automation.decide.successes"),
  failures: Metric.counter("crablet.automation.decide.failures")
};

// Tag with ("automation", automationName). Counts trigger events handled, not decisions - matches
// AutomationEventHandler.ts's own "trigger event counts once regardless of decision count" semantics.
export const eventsProcessed = Metric.counter("crablet.automation.events_processed");
