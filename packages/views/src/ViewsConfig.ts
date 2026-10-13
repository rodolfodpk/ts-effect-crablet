import type { PollingConfig } from "@crablet/event-poller/ProcessorConfig";

// The views module's configuration: how its processors poll, back off and give up. Everything is optional: what is left out takes its value from
// `defaultPollingConfig` (@crablet/event-poller/ProcessorConfig). A single view can still override the
// polling and backoff settings of its own.
export type ViewsConfig = Partial<PollingConfig>;
