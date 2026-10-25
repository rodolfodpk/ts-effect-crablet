import { Metric } from "effect";

// crablet.deadlines.fired: deadlines fired (ADR-0043). Tag with ("outcome", "appended" | "noop" | "failed"). How many are due and how late the oldest is
// are the deadlines processor's lag gauges (MonitorProcessors), read from crablet_deadlines.
export const fired = Metric.counter("crablet.deadlines.fired");
