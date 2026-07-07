import { Metric } from "effect";
import type { OperationMetrics } from "./internal/observe.ts";

export { observe } from "./internal/observe.ts";

// Port of the Java Observation names crablet.eventstore.append /
// crablet.eventstore.concurrency.violation / crablet.eventstore.event.type - the modern,
// recommended naming scheme (CrabletObservationNames.java), not the deprecated
// eventstore.events.appended-style dashboard-compat names.
export const append: OperationMetrics = {
  duration: Metric.timer("crablet.eventstore.append.duration"),
  successes: Metric.counter("crablet.eventstore.append.successes"),
  failures: Metric.counter("crablet.eventstore.append.failures")
};

export const eventsAppended = Metric.counter("crablet.eventstore.events_appended");

// Tag with ("event_type", type) at the call site, once per distinct event type in an appended batch.
export const eventTypeAppended = Metric.counter("crablet.eventstore.event_type_appended");

// A dedicated counter alongside `append.failures` - the one failure mode Java calls out
// specifically (ConcurrencyViolationMetric), not just folded into the generic failure count.
export const concurrencyViolations = Metric.counter("crablet.eventstore.concurrency_violations");
