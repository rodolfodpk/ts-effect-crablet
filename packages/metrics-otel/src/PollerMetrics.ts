import { Metric } from "effect";

// crablet.poller.processing.cycle / crablet.poller.backoff - wired ONCE into
// event-poller's shared EventProcessor.ts engine, so views/outbox/automations all get
// cycle/backoff instrumentation for free without any per-consumer-module wiring (mirrors ADR-0007's
// "one shared engine, zero per-consumer duplication" win, just for metrics instead of scheduling).
// Tag with ("processor", processorId) and ("instance_id", instanceId) at the call site.
export const processingCycles = Metric.counter("crablet.poller.processing_cycles");
export const eventsFetched = Metric.counter("crablet.poller.events_fetched");
export const emptyPolls = Metric.counter("crablet.poller.empty_polls");

export const backoffActive = Metric.gauge("crablet.poller.backoff_active");
export const backoffEmptyPollCount = Metric.gauge("crablet.poller.backoff_empty_poll_count");

// Set by `monitorProcessors` (@crablet/event-poller/MonitorProcessors), not by the processing loop, so a processor with no leader still reports.
// Tag with ("processor", processorId) and ("instance_id", instanceId of the reporting instance); every instance reports the same value, so aggregate
// with max, not sum. For a view the processor id is the view name; for the outbox it is the JSON pair `["topic","publisher"]`.
//
// Events the processor selects that are committed and after its cursor, counted up to 100 000 (a processor further behind reads 100 000).
export const lagEvents = Metric.gauge("crablet.poller.lag_events");
// Age in seconds, by the events' own occurred_at, of the first of those events; 0 when the processor is caught up.
export const lagSeconds = Metric.gauge("crablet.poller.lag_seconds");
// The cursor's position. A double: exact up to 2^53, which is far beyond any log this runs against.
export const cursorPosition = Metric.gauge("crablet.poller.cursor_position");
// Tagged also with ("status", "ACTIVE" | "PAUSED" | "FAILED"): 1 for the processor's current status, 0 for the other two.
export const status = Metric.gauge("crablet.poller.status");
