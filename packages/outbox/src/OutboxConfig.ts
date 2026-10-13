import type { PollingConfig } from "@crablet/event-poller/ProcessorConfig";

// The outbox module's configuration: how its processors poll, back off and give up. Everything is optional: what is left out takes its value from
// `defaultPollingConfig` (@crablet/event-poller/ProcessorConfig). A single topic publisher can still override the
// polling and backoff settings of its own.
export type OutboxConfig = Partial<PollingConfig>;
