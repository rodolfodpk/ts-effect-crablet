import { Metric } from "effect";
import type { OperationMetrics } from "./internal/observe.ts";

export { observe } from "./internal/observe.ts";

// Port of crablet.outbox.publish. Tag with ("publisher", publisherName) at the call site.
export const publish: OperationMetrics = {
  duration: Metric.timer("crablet.outbox.publish.duration"),
  successes: Metric.counter("crablet.outbox.publish.successes"),
  failures: Metric.counter("crablet.outbox.publish.failures")
};

// Tag with ("publisher", publisherName).
export const eventsPublished = Metric.counter("crablet.outbox.events_published");
