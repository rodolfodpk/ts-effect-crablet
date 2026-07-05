import type { Tag } from "./Tag.ts";

// Port of com.crablet.eventstore.query.QueryItem / Query.
export interface QueryItem {
  readonly eventTypes: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<Tag>;
}

export const queryItemOf = (eventTypes: ReadonlyArray<string>, tags: ReadonlyArray<Tag>): QueryItem => ({
  eventTypes,
  tags
});
export const queryItemOfTypes = (eventTypes: ReadonlyArray<string>): QueryItem => queryItemOf(eventTypes, []);
export const queryItemOfTags = (tags: ReadonlyArray<Tag>): QueryItem => queryItemOf([], tags);
export const queryItemOfType = (eventType: string): QueryItem => queryItemOf([eventType], []);
export const queryItemOfTag = (tag: Tag): QueryItem => queryItemOf([], [tag]);

export interface Query {
  readonly items: ReadonlyArray<QueryItem>;
}

export const of = (items: ReadonlyArray<QueryItem> | QueryItem): Query => {
  if (Array.isArray(items)) return { items };
  return { items: [items as QueryItem] };
};

// Structurally identical to empty() but semantically distinct inside AppendCondition:
// empty() means "accept all event types"; noCondition() means "this check does not apply".
//
// PATTERN NOTE: TypeScript's type system is *structural*, not nominal - two values with the same
// shape (`{ items: [] }`) are the same type as far as the compiler is concerned, full stop. Unlike
// Java, there's no way to make `empty()`'s return value a distinct type from `noCondition()`'s just
// by giving them different names; the compiler cannot catch a mix-up between the two here. The two
// factory functions exist purely for *readability at the call site* (self-documenting code), not
// for type safety - keep that distinction in mind whenever you see two differently-named factories
// producing the same shape in this codebase.
export const empty = (): Query => ({ items: [] });
export const noCondition = (): Query => ({ items: [] });

export const forEventAndTag = (eventType: string, tagKey: string, tagValue: string): Query =>
  of(queryItemOf([eventType], [{ key: tagKey.toLowerCase(), value: tagValue }]));

export const forEventAndTags = (eventType: string, tags: ReadonlyArray<Tag>): Query =>
  of(queryItemOf([eventType], tags));

export const forEvent = (eventType: string): Query => of(queryItemOfType(eventType));

export const forEventsAndTags = (eventTypes: ReadonlyArray<string>, tags: ReadonlyArray<Tag>): Query =>
  of(queryItemOf(eventTypes, tags));

export const isEmpty = (query: Query): boolean => query.items.length === 0;
