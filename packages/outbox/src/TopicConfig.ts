import * as EventSelectionNS from "@crablet/event-poller/EventSelection";
import type { EventSelection } from "@crablet/event-poller/EventSelection";
import type { ProcessorRuntimeOverrides } from "@crablet/event-poller/ProcessorRuntimeOverrides";

// A publisher assigned to a topic, with
// optional per-publisher runtime overrides (e.g. its own pollingIntervalMs).
export interface TopicPublisherAssignment extends ProcessorRuntimeOverrides {
  readonly name: string;
}

// A topic's matching criteria (EventSelection) plus the
// publishers assigned to it. Every assigned publisher advances independently through this same
// selection (each pair is a processor of its own, fetching with its topic's selection).
export interface TopicConfig extends EventSelection {
  readonly topic: string;
  readonly publishers: ReadonlyArray<TopicPublisherAssignment>;
}

const normalizeAssignment = (assignment: string | TopicPublisherAssignment): TopicPublisherAssignment =>
  typeof assignment === "string" ? { name: assignment } : assignment;

export const topicConfigOf = (
  topic: string,
  fields: Partial<EventSelection> & { publishers: ReadonlyArray<string | TopicPublisherAssignment> }
): TopicConfig => ({
  topic,
  ...EventSelectionNS.of(fields),
  publishers: fields.publishers.map(normalizeAssignment)
});
