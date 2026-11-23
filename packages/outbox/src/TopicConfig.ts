import * as EventSelectionNS from "@crablet/event-poller/EventSelection";
import type { EventSelection } from "@crablet/event-poller/EventSelection";
import type { ProcessorRuntimeOverrides } from "@crablet/event-poller/ProcessorRuntimeOverrides";

// A publisher assigned to a topic, by name, with optional per-publisher runtime overrides (e.g. its own pollingIntervalMs).
export interface TopicPublisherAssignment<P extends string = string> extends ProcessorRuntimeOverrides {
  readonly publisher: P;
}

// A topic's matching criteria (EventSelection) plus the publishers assigned to it. Every assigned publisher advances independently through this same
// selection (each pair is a processor of its own, fetching with its topic's selection).
export interface TopicConfig<P extends string = string> extends EventSelection {
  readonly topic: string;
  readonly publishers: ReadonlyArray<TopicPublisherAssignment<P>>;
}

// The publisher names a list of topics uses.
export type PublisherNamesOf<T extends ReadonlyArray<TopicConfig<string>>> = T[number] extends TopicConfig<infer P> ? P : never;

const normalizeAssignment = <P extends string>(assignment: P | TopicPublisherAssignment<P>): TopicPublisherAssignment<P> =>
  typeof assignment === "string" ? { publisher: assignment } : assignment;

// A topic names its publishers; the processor that runs it is given one publisher per name (`startOutboxProcessor({ topics, publishers })`), and a
// name with no publisher does not compile (ADR-0039, amended 2026-11-23). The declaration holds no publisher, so a process that only lists or controls the
// outbox's processors (an API) declares the topics without building a client for the broker. The topic's name and each publisher's name key their progress
// row: renaming either starts that pair again from the beginning of the log.
export const defineTopic = <const P extends string>(
  topic: string,
  fields: Partial<EventSelection> & { readonly publishers: ReadonlyArray<P | TopicPublisherAssignment<P>> }
): TopicConfig<P> => ({
  topic,
  ...EventSelectionNS.of(fields),
  publishers: fields.publishers.map(normalizeAssignment)
});
