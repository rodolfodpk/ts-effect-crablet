import { Metric } from "effect";

// Port of crablet.poller.leadership. Tag with ("processor", processorId) and
// ("instance_id", instanceId) at the call site; set to 1 on acquiring leadership, 0 on losing it.
export const leadership = Metric.gauge("crablet.poller.leadership");
