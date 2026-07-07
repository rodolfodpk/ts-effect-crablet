import { Metric } from "effect";
import type { OperationMetrics } from "./internal/observe.ts";

export { observe } from "./internal/observe.ts";

// Port of crablet.view.project. Tag with ("view", viewName) at the call site.
export const project: OperationMetrics = {
  duration: Metric.timer("crablet.view.project.duration"),
  successes: Metric.counter("crablet.view.project.successes"),
  failures: Metric.counter("crablet.view.project.failures")
};

// Tag with ("view", viewName).
export const eventsProjected = Metric.counter("crablet.view.events_projected");
