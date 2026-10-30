import * as TagNS from "./Tag.ts";
import type { Tag } from "./Tag.ts";

export interface QueryItem {
  readonly eventTypes: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<Tag>;
}

// An item targets events by type and/or tags (the DCB specification): one with neither matches nothing the specification defines, so it is refused
// here, and the store refuses one built without this function (`emptyItemIn`). Every event is a query with no items in a read (ADR-0049).
const EMPTY_ITEM = "a query item targets events by type and/or tags: give it at least one (ADR-0049)";

export const queryItemOf = (eventTypes: ReadonlyArray<string>, tags: ReadonlyArray<Tag>): QueryItem => {
  if (eventTypes.length === 0 && tags.length === 0) throw new Error(EMPTY_ITEM);
  return { eventTypes, tags };
};
export const queryItemOfType = (eventType: string): QueryItem => queryItemOf([eventType], []);

export interface Query {
  readonly items: ReadonlyArray<QueryItem>;
}

export const of = (items: ReadonlyArray<QueryItem> | QueryItem): Query => {
  if (Array.isArray(items)) return { items };
  return { items: [items as QueryItem] };
};

// No items: inside an AppendCondition, "this check does not apply"; in a read, every event.
export const noCondition = (): Query => ({ items: [] });

export const forEventAndTag = (eventType: string, tagKey: string, tagValue: string): Query =>
  of(queryItemOf([eventType], [TagNS.of(tagKey, tagValue)]));

export const forEventAndTags = (eventType: string, tags: ReadonlyArray<Tag>): Query =>
  of(queryItemOf([eventType], tags));

export const forEvent = (eventType: string): Query => of(queryItemOfType(eventType));

export const forEventsAndTags = (eventTypes: ReadonlyArray<string>, tags: ReadonlyArray<Tag>): Query =>
  of(queryItemOf(eventTypes, tags));

export const isEmpty = (query: Query): boolean => query.items.length === 0;

// Why the store refuses `query`, or null: an item with neither types nor tags (one built without `queryItemOf`). A defect, not a typed error.
export const emptyItemIn = (query: Query): string | null =>
  query.items.some((i) => i.eventTypes.length === 0 && i.tags.length === 0) ? EMPTY_ITEM : null;
