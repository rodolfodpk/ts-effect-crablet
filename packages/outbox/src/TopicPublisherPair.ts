// Port of com.crablet.outbox.TopicPublisherPair - the composite (topic, publisher) processor
// identity outbox uses (a topic can have several publishers, each advancing independently).
// @crablet/event-poller's engine requires `I extends string`, so this pair is encoded into a
// single string for engine plumbing and decoded back wherever the real (topic, publisher) columns
// are needed for SQL - a `"::"`-joined string would NOT be safely reversible here, since
// crablet_outbox_topic_progress's CHECK constraints only bound topic/publisher *length*, not
// content, so a literal "::" inside either value would silently produce a wrong split.
// JSON.stringify/parse is collision-free regardless of content.
export interface TopicPublisherPair {
  readonly topic: string;
  readonly publisher: string;
}

export const toKey = (pair: TopicPublisherPair): string => JSON.stringify([pair.topic, pair.publisher]);

export const fromKey = (key: string): TopicPublisherPair => {
  const value: unknown = JSON.parse(key);
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string") {
    throw new Error(`Invalid TopicPublisherPair key: ${key}`);
  }
  return { topic: value[0], publisher: value[1] };
};
