// Port of crablet-eventstore's PostgresNotifyPayload.java (encode side) and
// PostgresNotifyWakeupSource.java's payload parsing (decode side).
// Must stay byte-identical to the Java implementation - this is a cross-language wire contract.
//
// PATTERN NOTE: nothing in this file returns an `Effect` - and that's deliberate, not an
// oversight. `Effect` is for computations that are asynchronous, can fail in a tracked way, or
// need ambient services (see EventStore.ts's primer on the three type parameters); plain string
// parsing/formatting with no I/O and no meaningful failure mode is just... a plain function. Don't
// reach for `Effect.succeed(...)`-wrapping pure logic by default - it adds no safety and forces
// every caller to unwrap it with `yield*` for nothing. This file (and BackoffState.ts in
// event-poller, for the same reason) are the two clearest "plain functions are enough" examples in
// the codebase.

const MAX_PAYLOAD_LENGTH = 7900;

export function encodePayload(eventTypes: ReadonlySet<string>, tagKeys: ReadonlySet<string>): string {
  if (eventTypes.size === 0) return "*";

  const typesPart = [...eventTypes].sort().join(",");
  if (tagKeys.size === 0) {
    return typesPart.length <= MAX_PAYLOAD_LENGTH ? typesPart : "*";
  }

  const tagPart = [...tagKeys].sort().join(",");
  const combined = `${typesPart}|${tagPart}`;
  if (combined.length <= MAX_PAYLOAD_LENGTH) return combined;
  return typesPart.length <= MAX_PAYLOAD_LENGTH ? typesPart : "*";
}

export function isWildcard(payload: string | null | undefined): boolean {
  return payload == null || payload.trim().length === 0 || payload === "*";
}

export interface DecodedPayload {
  readonly wildcard: boolean;
  readonly types: ReadonlySet<string>;
  readonly tagKeys: ReadonlySet<string>;
}

export function decodePayload(payload: string | null | undefined): DecodedPayload {
  if (isWildcard(payload)) {
    return { wildcard: true, types: new Set(), tagKeys: new Set() };
  }
  const raw = payload as string;
  const barIndex = raw.indexOf("|");
  const typesSection = barIndex === -1 ? raw : raw.slice(0, barIndex);
  const tagSection = barIndex === -1 ? "" : raw.slice(barIndex + 1);

  const types = new Set(typesSection.split(",").filter((s) => s.length > 0));
  const tagKeys = new Set(tagSection.split(",").filter((s) => s.length > 0));
  return { wildcard: false, types, tagKeys };
}

export interface SubscriberFilter {
  readonly eventTypes?: ReadonlySet<string>;
  readonly requiredTagKeys?: ReadonlySet<string>;
  readonly anyOfTagKeys?: ReadonlySet<string>;
  readonly exactTagKeys?: ReadonlySet<string>;
}

// Port of PostgresNotifyWakeupSource.shouldWake - in-memory pre-filter before the real SQL poll.
// Tag *value* matching is intentionally NOT done here (matches Java) - only key-name presence.
export function shouldWake(batch: DecodedPayload, filter: SubscriberFilter): boolean {
  if (batch.wildcard) return true;

  if (filter.eventTypes && filter.eventTypes.size > 0) {
    const intersects = [...filter.eventTypes].some((t) => batch.types.has(t));
    if (!intersects) return false;
  }

  if (batch.tagKeys.size > 0) {
    if (filter.requiredTagKeys && filter.requiredTagKeys.size > 0) {
      const allPresent = [...filter.requiredTagKeys].every((k) => batch.tagKeys.has(k));
      if (!allPresent) return false;
    }
    if (filter.anyOfTagKeys && filter.anyOfTagKeys.size > 0) {
      const anyPresent = [...filter.anyOfTagKeys].some((k) => batch.tagKeys.has(k));
      if (!anyPresent) return false;
    }
    if (filter.exactTagKeys && filter.exactTagKeys.size > 0) {
      const allPresent = [...filter.exactTagKeys].every((k) => batch.tagKeys.has(k));
      if (!allPresent) return false;
    }
  }

  return true;
}
