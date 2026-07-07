import { Metric } from "effect";

// Port of crablet.poller.processing.cycle / crablet.poller.backoff - wired ONCE into
// event-poller's shared EventProcessor.ts engine, so views/outbox/automations all get
// cycle/backoff instrumentation for free without any per-consumer-module wiring (mirrors ADR-0007's
// "one shared engine, zero per-consumer duplication" win, just for metrics instead of scheduling).
// Tag with ("processor", processorId) and ("instance_id", instanceId) at the call site.
export const processingCycles = Metric.counter("crablet.poller.processing_cycles");
export const eventsFetched = Metric.counter("crablet.poller.events_fetched");
export const emptyPolls = Metric.counter("crablet.poller.empty_polls");

export const backoffActive = Metric.gauge("crablet.poller.backoff_active");
export const backoffEmptyPollCount = Metric.gauge("crablet.poller.backoff_empty_poll_count");
