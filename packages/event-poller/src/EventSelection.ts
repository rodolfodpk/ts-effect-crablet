import type { SubscriberFilter } from "@crablet/eventstore/NotifyPayload";

// Port of com.crablet.eventpoller.EventSelection. Java models this as an interface with default
// methods returning empty collections; TS interfaces can't carry default-method bodies, so this is
// a plain, fully-populated data type instead (matching this repo's Query/Tag/AppendCondition
// style), with empty()/of() factories filling in the "unrestricted" defaults.
//
// Dimensions combine with AND: eventTypes empty = unrestricted; requiredTags = ALL keys must be
// present; anyOfTags = AT LEAST ONE key present; exactTags = ALL key=value pairs match exactly.
export interface EventSelection {
  readonly eventTypes: ReadonlySet<string>;
  readonly requiredTags: ReadonlySet<string>;
  readonly anyOfTags: ReadonlySet<string>;
  readonly exactTags: ReadonlyMap<string, string>;
}

export const empty = (): EventSelection => ({
  eventTypes: new Set(),
  requiredTags: new Set(),
  anyOfTags: new Set(),
  exactTags: new Map()
});

export const of = (partial: Partial<EventSelection>): EventSelection => ({ ...empty(), ...partial });

export const unionEventTypes = (selections: Iterable<EventSelection>): ReadonlySet<string> => {
  const union = new Set<string>();
  for (const s of selections) for (const t of s.eventTypes) union.add(t);
  return union;
};

export const unionRequiredTags = (selections: Iterable<EventSelection>): ReadonlySet<string> => {
  const union = new Set<string>();
  for (const s of selections) for (const k of s.requiredTags) union.add(k);
  return union;
};

export const unionAnyOfTags = (selections: Iterable<EventSelection>): ReadonlySet<string> => {
  const union = new Set<string>();
  for (const s of selections) for (const k of s.anyOfTags) union.add(k);
  return union;
};

export const unionExactTagKeys = (selections: Iterable<EventSelection>): ReadonlySet<string> => {
  const union = new Set<string>();
  for (const s of selections) for (const k of s.exactTags.keys()) union.add(k);
  return union;
};

// Bridges into the already-ported wakeup pre-filter (PostgresNotifyWakeupSource.shouldWake) -
// reused directly, not re-derived.
export const toSubscriberFilter = (s: EventSelection): SubscriberFilter => ({
  eventTypes: s.eventTypes,
  requiredTagKeys: s.requiredTags,
  anyOfTagKeys: s.anyOfTags,
  exactTagKeys: new Set(s.exactTags.keys())
});
