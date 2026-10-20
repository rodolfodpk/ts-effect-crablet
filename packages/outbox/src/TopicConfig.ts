import * as EventSelectionNS from "@crablet/event-poller/EventSelection";
import type { EventSelection } from "@crablet/event-poller/EventSelection";
import type { ProcessorRuntimeOverrides } from "@crablet/event-poller/ProcessorRuntimeOverrides";
import type { OutboxPublisher } from "./OutboxPublisher.ts";

// A publisher assigned to a topic, with
// optional per-publisher runtime overrides (e.g. its own pollingIntervalMs).
export interface TopicPublisherAssignment extends ProcessorRuntimeOverrides {
  readonly publisher: OutboxPublisher<any>;
}

// A topic's matching criteria (EventSelection) plus the
// publishers assigned to it. Every assigned publisher advances independently through this same
// selection (each pair is a processor of its own, fetching with its topic's selection).
export interface TopicConfig extends EventSelection {
  readonly topic: string;
  readonly publishers: ReadonlyArray<TopicPublisherAssignment>;
}

const normalizeAssignment = (assignment: OutboxPublisher<any> | TopicPublisherAssignment): TopicPublisherAssignment =>
  "publishBatch" in assignment ? { publisher: assignment } : assignment;

// A topic takes the publishers themselves, not their names, so it cannot name one the processor does not have: the processor runs the publishers
// of its topics (ADR-0039). The topic's name and each publisher's name key their progress row: renaming either starts that pair again from the
// beginning of the log.
export const defineTopic = (
  topic: string,
  fields: Partial<EventSelection> & { readonly publishers: ReadonlyArray<OutboxPublisher<any> | TopicPublisherAssignment> }
): TopicConfig => ({
  topic,
  ...EventSelectionNS.of(fields),
  publishers: fields.publishers.map(normalizeAssignment)
});
