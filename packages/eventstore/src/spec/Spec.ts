import type { AppendCondition } from "../AppendCondition.ts";
import type { Query, QueryItem } from "../Query.ts";
import type { Tag } from "../Tag.ts";
import type { LogPosition } from "../LogPosition.ts";
// The SPECIFICATION of reads and conditional appends, as pure functions over a list of events.
//
// The Postgres implementation (`append_events_if` and `queryEvents`) and the in-memory store both
// implement this; the conformance suite (test/conformance) runs the same cases against both, and a
// differential test feeds them identical random histories. If they ever disagree, one of them (or this
// file) is wrong - which is the point of having it written down once.

// What the spec needs to know about an event.
export interface SpecEvent {
  readonly type: string;
  readonly tags: ReadonlyArray<Tag>;
  readonly position: bigint;
  readonly transactionId?: string;
}

// An item matches an event when (types is empty OR the event's type is one of them) AND (the event
// carries ALL of the item's tags, key and value).
export const itemMatches = (item: QueryItem, event: SpecEvent): boolean =>
  (item.eventTypes.length === 0 || item.eventTypes.includes(event.type)) &&
  item.tags.every((t) => event.tags.some((x) => x.key === t.key && x.value === t.value));

// An item with neither types nor tags carries no information, so it is dropped.
export const informativeItems = (query: Query): ReadonlyArray<QueryItem> =>
  query.items.filter((i) => i.eventTypes.length > 0 || i.tags.length > 0);

// A query matches an event when ANY informative item does. A query with no informative item (an empty
// `Query.of([])`, or only information-free items) matches EVERYTHING when used to read.
export const queryMatches = (query: Query, event: SpecEvent): boolean => {
  const items = informativeItems(query);
  return items.length === 0 || items.some((i) => itemMatches(i, event));
};

// What a conditional append decides.
//   "duplicate" - the idempotency query matches an existing event (at ANY position)
//   "conflict"  - the concurrency query matches an event NEWER than `afterPosition`
//   "ok"        - append
// Idempotency is checked first: if both would refuse, the answer is "duplicate". A condition whose
// query has no informative items performs no such check (as opposed to a read, where it matches all).
export type Verdict = "ok" | "duplicate" | "conflict";

// The cursor is a (transactionId, position) pair, compared in that order (the order a load returns events in);
// a cursor or an event without a transaction id compares by position alone.
const isAfterCursor = (e: SpecEvent, cursor: LogPosition): boolean =>
  cursor.transactionId === null || e.transactionId === undefined
    ? e.position > cursor.position
    : BigInt(e.transactionId) > BigInt(cursor.transactionId) ||
      (BigInt(e.transactionId) === BigInt(cursor.transactionId) && e.position > cursor.position);

export const checkAppend = (log: ReadonlyArray<SpecEvent>, condition: AppendCondition): Verdict => {
  const idempotency = informativeItems(condition.idempotencyQuery);
  if (idempotency.length > 0 && log.some((e) => idempotency.some((i) => itemMatches(i, e)))) {
    return "duplicate";
  }
  const concurrency = informativeItems(condition.concurrencyQuery);
  if (
    concurrency.length > 0 &&
    log.some((e) => isAfterCursor(e, condition.afterPosition) && concurrency.some((i) => itemMatches(i, e)))
  ) {
    return "conflict";
  }
  return "ok";
};
