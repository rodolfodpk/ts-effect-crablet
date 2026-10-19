import type { PollingConfig } from "@crablet/event-poller/ProcessorConfig";

// The outbox module's configuration: how its processors poll, back off and give up, and how long one publish may take. Everything is optional: what is
// left out takes its value from `defaultPollingConfig` (@crablet/event-poller/ProcessorConfig) and `defaultPublishTimeoutMs`. A single topic publisher
// can still override the polling and backoff settings of its own.
export interface OutboxConfig extends Partial<PollingConfig> {
  // How long one call to a publisher's `publishBatch` may take before it counts as failed (default 30 s): a destination that hangs would otherwise hold
  // its topic back for good while the leader keeps its lock. A timed-out publish may still have reached the destination; the batch is published again,
  // which at-least-once allows (ADR-0036).
  readonly publishTimeoutMs?: number;
}

export const defaultPublishTimeoutMs = 30_000;
