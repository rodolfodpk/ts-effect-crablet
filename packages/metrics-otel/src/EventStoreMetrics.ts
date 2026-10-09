import { Metric } from "effect";
import type { OperationMetrics } from "./internal/observe.ts";

export { observe } from "./internal/observe.ts";

// crablet.eventstore.append / crablet.eventstore.concurrency.violation /
// crablet.eventstore.event.type.
export const append: OperationMetrics = {
  duration: Metric.timer("crablet.eventstore.append.duration"),
  successes: Metric.counter("crablet.eventstore.append.successes"),
  failures: Metric.counter("crablet.eventstore.append.failures")
};

export const eventsAppended = Metric.counter("crablet.eventstore.events_appended");

// Tag with ("event_type", type) at the call site, once per distinct event type in an appended batch.
export const eventTypeAppended = Metric.counter("crablet.eventstore.event_type_appended");

// A dedicated counter alongside `append.failures` - the one failure mode worth calling out
// specifically, not just folding it into the generic failure count.
export const concurrencyViolations = Metric.counter("crablet.eventstore.concurrency_violations");

// A stored event that its definition could not decode (ADR-0017): one count each time a read stopped because of it. Tag with ("event_type", type).
export const decodingFailures = Metric.counter("crablet.eventstore.decoding_failures");

// Wake-up notifications (ADR-0021). Recorded: one per append (or per committed transaction). Sent: one `pg_notify` actually issued. Saved: signals folded into another notification
// by coalescing (recorded - sent, once everything pending has gone out).
export const wakeupsRecorded = Metric.counter("crablet.eventstore.wakeups_recorded");
export const wakeupsSent = Metric.counter("crablet.eventstore.wakeups_sent");
export const wakeupsSaved = Metric.counter("crablet.eventstore.wakeups_saved");
