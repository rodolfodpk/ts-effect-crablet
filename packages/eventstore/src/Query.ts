import * as TagNS from "./Tag.ts";
import type { Tag } from "./Tag.ts";

export interface QueryItem {
  readonly eventTypes: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<Tag>;
}

// An item targets events by type and/or tags (the DCB specification): one with neither matches nothing the specification defines, so it is refused
// here, and the store refuses one built without this function (`emptyItemIn`, ADR-0049). Every event is `all()` (ADR-0050).
const EMPTY_ITEM = "a query item targets events by type and/or tags: give it at least one (ADR-0049)";

export const queryItemOf = (eventTypes: ReadonlyArray<string>, tags: ReadonlyArray<Tag>): QueryItem => {
  if (eventTypes.length === 0 && tags.length === 0) throw new Error(EMPTY_ITEM);
  return { eventTypes, tags };
};
export const queryItemOfType = (eventType: string): QueryItem => queryItemOf([eventType], []);

export interface Query {
  readonly items: ReadonlyArray<QueryItem>;
  // Every event (`all()`), with no items: the DCB specification's "query that matches all Events". In a read, every event; in a condition, any event
  // after the cursor is a conflict, which takes the global writer lock (every other append waits for it). ADR-0050.
  readonly all?: true;
}

export const of = (items: ReadonlyArray<QueryItem> | QueryItem): Query => {
  if (Array.isArray(items)) return { items };
  return { items: [items as QueryItem] };
};

// No items: inside an AppendCondition, "this check does not apply"; in `project`, every event. The reads made for direct use (`read`, `stream`,
// `readToDecide`) refuse it: there, every event is `all()`.
export const noCondition = (): Query => ({ items: [] });

// Every event (ADR-0050).
export const all = (): Query => ({ items: [], all: true });

export const isAll = (query: Query): boolean => query.all === true;

// The queries together: every event when one of them is, else their items.
export const union = (...queries: ReadonlyArray<Query>): Query => (queries.some(isAll) ? all() : of(queries.flatMap((q) => q.items)));

export const forEventAndTag = (eventType: string, tagKey: string, tagValue: string): Query =>
  of(queryItemOf([eventType], [TagNS.of(tagKey, tagValue)]));

export const forEventAndTags = (eventType: string, tags: ReadonlyArray<Tag>): Query =>
  of(queryItemOf([eventType], tags));

export const forEvent = (eventType: string): Query => of(queryItemOfType(eventType));

export const forEventsAndTags = (eventTypes: ReadonlyArray<string>, tags: ReadonlyArray<Tag>): Query =>
  of(queryItemOf(eventTypes, tags));

// The short form (ADR-0052): one item, by its types and its tags as an object, `match(["CopyLent", "CopyReturned"], { copy_id: id })`. A tag whose
// value is missing (null or undefined) is refused: dropping it would widen what the query selects, and a decision would read other entities'
// events. Several items: `union(match(...), match(...))`; one key with several values: `queryItemOf`.
export const match = (
  types: string | ReadonlyArray<string>,
  tags: Readonly<Record<string, string | number | null | undefined>> = {}
): Query =>
  of(
    queryItemOf(
      typeof types === "string" ? [types] : types,
      Object.entries(tags).map(([key, value]) => {
        if (value === null || value === undefined) throw new Error(`Query.match: the tag "${key}" has no value; a query cannot leave a tag out`);
        return TagNS.of(key, String(value));
      })
    )
  );

// No items and not `all()`: no query at all.
export const isEmpty = (query: Query): boolean => query.items.length === 0 && !isAll(query);

// Why the store refuses `query`, or null: an item with neither types nor tags (one built without `queryItemOf`). A defect, not a typed error.
export const emptyItemIn = (query: Query): string | null =>
  query.items.some((i) => i.eventTypes.length === 0 && i.tags.length === 0) ? EMPTY_ITEM : null;
