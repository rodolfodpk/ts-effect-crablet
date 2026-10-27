import type { Tag } from "./Tag.ts";

export interface QueryItem {
  readonly eventTypes: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<Tag>;
}

export const queryItemOf = (eventTypes: ReadonlyArray<string>, tags: ReadonlyArray<Tag>): QueryItem => ({
  eventTypes,
  tags
});
export const queryItemOfType = (eventType: string): QueryItem => queryItemOf([eventType], []);

export interface Query {
  readonly items: ReadonlyArray<QueryItem>;
}

export const of = (items: ReadonlyArray<QueryItem> | QueryItem): Query => {
  if (Array.isArray(items)) return { items };
  return { items: [items as QueryItem] };
};

// No items: inside an AppendCondition, "this check does not apply".
export const noCondition = (): Query => ({ items: [] });

export const forEventAndTag = (eventType: string, tagKey: string, tagValue: string): Query =>
  of(queryItemOf([eventType], [{ key: tagKey.toLowerCase(), value: tagValue }]));

export const forEventAndTags = (eventType: string, tags: ReadonlyArray<Tag>): Query =>
  of(queryItemOf([eventType], tags));

export const forEvent = (eventType: string): Query => of(queryItemOfType(eventType));

export const forEventsAndTags = (eventTypes: ReadonlyArray<string>, tags: ReadonlyArray<Tag>): Query =>
  of(queryItemOf(eventTypes, tags));

export const isEmpty = (query: Query): boolean => query.items.length === 0;
