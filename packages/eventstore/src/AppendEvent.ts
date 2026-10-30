import * as Tag from "./Tag.ts";
import type { Tag as TagType } from "./Tag.ts";

// An event to append. Event data is serialized (JSON.stringify) by the
// EventStore implementation - callers pass a plain object, not a pre-serialized string.
export interface AppendEvent {
  readonly type: string;
  readonly tags: ReadonlyArray<TagType>;
  readonly eventData: unknown;
}

// PATTERN PRIMER - when to reach for a class instead of the namespace-module style (see Tag.ts's
// primer for the default). A builder needs (a) several optional/repeatable calls before the value
// is complete (`tag(...)` called any number of times) and (b) validation deferred to one final
// step (`build()`), not at every intermediate call. Modeling that as pure functions would mean
// either one giant factory taking every possible tag up front, or manually threading a growing
// "partial" object through a chain of function calls - both are more awkward than a small class
// with private mutable fields that only exists transiently during construction. This is the one
// place in the codebase reaching for OOP-style mutation: the *result* (`AppendEvent`) is still a
// plain readonly object, only the builder itself is stateful, and only for the few lines it's
// alive.
export class AppendEventBuilder {
  private readonly _type: string;
  private _tags: Array<TagType> = [];
  private _eventData: unknown;

  constructor(type: string) {
    this._type = type;
  }

  tags(moreTags: ReadonlyArray<TagType>): this {
    this._tags.push(...moreTags);
    return this;
  }

  tag(key: string, value: string | number | null | undefined): this {
    if (value === null || value === undefined) return this;
    this._tags.push(Tag.of(key, String(value)));
    return this;
  }

  data(eventData: unknown): this {
    this._eventData = eventData;
    return this;
  }

  build(): AppendEvent {
    if (this._eventData === undefined || this._eventData === null) {
      throw new Error("Event data cannot be null");
    }
    return { type: this._type, tags: [...this._tags], eventData: this._eventData };
  }
}

export const builder = (type: string): AppendEventBuilder => new AppendEventBuilder(type);

// Concise factory for the common single-tag case.
export const of = (type: string, tagKey: string, tagValue: string, eventData: unknown): AppendEvent =>
  builder(type).tag(tagKey, tagValue).data(eventData).build();

// Concise factory for events with no tags (tag is on the decision model, not the event).
export const ofUntagged = (type: string, eventData: unknown): AppendEvent =>
  builder(type).data(eventData).build();

