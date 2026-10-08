import { Metric } from "effect";

// crablet.poller.leadership: 1 when this instance holds a MODULE's leader lock, 0 when it loses it. Leadership is per module, not per processor: one advisory lock for all the
// views, one for the automations, one for the outbox publishers (packages/eventstore/src/Leader.ts), so it is tagged ("lock_key", the lock's number) and ("instance_id", the instance).
//
// A leader that crashes never reports 0: its series stays at 1 until the backend drops it (about five minutes in Prometheus) but stops being re-sent, so "the leader" is a series at 1
// that was written recently (ops/grafana). Observed by killing a leader (docs/plans/dashboard.md, the crash test).
export const leadership = Metric.gauge("crablet.poller.leadership");
