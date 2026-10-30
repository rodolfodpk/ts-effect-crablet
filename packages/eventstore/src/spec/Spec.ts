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

// A query matches an event when ANY item does. A query with no items (`Query.of([])`) matches EVERYTHING when used to read. An item with neither
// types nor tags is not a query item at all (it targets events by type and/or tags): both stores refuse it (Query.emptyItemIn, ADR-0049).
// (`Query.all()` has no items, so it matches everything here too.)
export const queryMatches = (query: Query, event: SpecEvent): boolean =>
  query.items.length === 0 || query.items.some((i) => itemMatches(i, event));

// What a condition's query checks: `all()` every event, else its items (none: no check).
const conditionMatches = (query: Query, event: SpecEvent): boolean => query.all === true || query.items.some((i) => itemMatches(i, event));

// What a conditional append decides.
//   "duplicate" - the idempotency query matches an existing event (at ANY position)
//   "conflict"  - the concurrency query matches an event NEWER than `afterPosition`
//   "ok"        - append
// Idempotency is checked first: if both would refuse, the answer is "duplicate". A condition whose
// query has no items performs no such check (as opposed to a read, where it matches all).
export type Verdict = "ok" | "duplicate" | "conflict";

// The cursor is a (transactionId, position) pair, compared in that order (the order a load returns events in);
// a cursor or an event without a transaction id compares by position alone.
const isAfterCursor = (e: SpecEvent, cursor: LogPosition): boolean =>
  cursor.transactionId === null || e.transactionId === undefined
    ? e.position > cursor.position
    : BigInt(e.transactionId) > BigInt(cursor.transactionId) ||
      (BigInt(e.transactionId) === BigInt(cursor.transactionId) && e.position > cursor.position);

export const checkAppend = (log: ReadonlyArray<SpecEvent>, condition: AppendCondition): Verdict => {
  if (log.some((e) => conditionMatches(condition.idempotencyQuery, e))) {
    return "duplicate";
  }
  if (log.some((e) => isAfterCursor(e, condition.afterPosition) && conditionMatches(condition.concurrencyQuery, e))) {
    return "conflict";
  }
  return "ok";
};
