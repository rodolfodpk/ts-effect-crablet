// Port of com.crablet.eventstore.Tag. Stored in Postgres as TEXT[] with "key=value" format.
// Tag keys are normalized to lowercase (repo-wide convention); values remain case-sensitive.
export interface Tag {
  readonly key: string;
  readonly value: string;
}

export const of = (key: string, value: string): Tag => ({ key: key.toLowerCase(), value });

// Alternating key/value pairs, mirroring Tag.of(String... keyValuePairs) in Java.
export const ofPairs = (...keyValuePairs: ReadonlyArray<string>): ReadonlyArray<Tag> => {
  if (keyValuePairs.length % 2 !== 0) {
    throw new Error("Key-value pairs must be even");
  }
  const tags: Array<Tag> = [];
  for (let i = 0; i < keyValuePairs.length; i += 2) {
    tags.push(of(keyValuePairs[i]!, keyValuePairs[i + 1]!));
  }
  return tags;
};
