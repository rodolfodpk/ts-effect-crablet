// Port of com.crablet.eventstore.Tag. Stored in Postgres as TEXT[] with "key=value" format.
// Tag keys are normalized to lowercase (repo-wide convention); values remain case-sensitive.
//
// PATTERN PRIMER - "namespace module" (used throughout this whole codebase instead of Java's
// "final class of static methods"): a file exports a plain `interface` for the data shape, plus
// free functions (constructors/helpers) that operate on it - no class, no `this`. Callers import
// the whole file as a namespace object: `import * as Tag from "./Tag.ts"` then `Tag.of(...)`.
// This mirrors how a Java static factory class is used (`Tag.of(...)`) without needing a class at
// all - TS values and types share a name (`Tag` the interface vs `Tag.of` the imported namespace)
// without colliding, because the interface is exported separately from the default/namespace
// import. You'll see this same shape in almost every file in this repo (Query.ts, AppendEvent.ts,
// AppendCondition.ts, StreamPosition.ts, EventSelection.ts, BackoffState.ts, ...) - it's the
// default choice here; a real `class` only shows up where genuinely stateful, multi-step
// construction benefits from it (see AppendEvent.ts's `AppendEventBuilder`) or where Effect's own
// APIs require a class (`Context.Tag`, `Data.TaggedError` - see EventStore.ts and DCBViolation.ts).
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
