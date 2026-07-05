import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import type { Query } from "@crablet/eventstore/Query";
import type { StreamPosition } from "@crablet/eventstore/StreamPosition";

// Port of com.crablet.command.OnDuplicate.
export type OnDuplicate = "THROW" | "RETURN_IDEMPOTENT";

// Port of com.crablet.command.IdempotencyKey.
export interface IdempotencyKey {
  readonly eventType: string;
  readonly tagKey: string;
  readonly tagValue: string;
  readonly onDuplicate: OnDuplicate;
}

export const idempotencyKeyOf = (
  eventType: string,
  tagKey: string,
  tagValue: string,
  onDuplicate: OnDuplicate = "RETURN_IDEMPOTENT"
): IdempotencyKey => {
  if (!eventType.trim()) throw new Error("IdempotencyKey eventType must not be blank");
  if (!tagKey.trim()) throw new Error("IdempotencyKey tagKey must not be blank");
  if (!tagValue.trim()) throw new Error("IdempotencyKey tagValue must not be blank");
  return { eventType, tagKey, tagValue, onDuplicate };
};

// Port of com.crablet.command.CommandDecision - a sealed interface in Java, a discriminated
// union here. CommandExecutor pattern-matches on `_tag` to call the correct EventStore append
// method, exactly as CommandExecutorImpl's switch does.
//
// PATTERN PRIMER - "discriminated union", TypeScript's direct equivalent of a Java `sealed
// interface` with several `record` implementations. Each variant below (`Commutative`,
// `CommutativeGuarded`, ...) is a plain interface with a `readonly _tag: "SomeLiteralString"`
// field - a *literal* string type, not just `string`, so TypeScript can narrow on it. The union
// type at the bottom (`export type CommandDecision = Commutative | ... | NoOp`) is the "sealed"
// part: it's a closed set, known at compile time. `CommandExecutor.ts`'s `switch (decision._tag)`
// then gets *exhaustiveness checking* for free: TypeScript narrows `decision`'s type inside each
// `case` branch (e.g. inside `case "NonCommutative":`, `decision` is known to have `decisionModel`/
// `streamPosition` fields, with no cast needed), and if a new variant is ever added to the union
// without a matching `case`, the switch's fallthrough becomes a type error rather than a silent
// runtime gap - the same guarantee Java's sealed-interface-exhaustive-switch gives you. This exact
// `_tag` mechanism is also what `Data.TaggedError` (see eventstore's DCBViolation.ts) generates
// automatically for error types, and what `Effect.catchTag`/`Effect.exit` narrow on.

export interface Commutative {
  readonly _tag: "Commutative";
  readonly events: ReadonlyArray<AppendEvent>;
  readonly idempotencyKey: IdempotencyKey | null;
}

export const commutative = (...events: ReadonlyArray<AppendEvent>): Commutative => ({
  _tag: "Commutative",
  events,
  idempotencyKey: null
});

export const commutativeIdempotent = (
  decision: Commutative,
  eventType: string,
  tagKey: string,
  tagValue: string,
  onDuplicate?: OnDuplicate
): Commutative => ({ ...decision, idempotencyKey: idempotencyKeyOf(eventType, tagKey, tagValue, onDuplicate) });

/**
 * Commutative with selective lifecycle guard. Parallel operations of the same type (e.g.
 * concurrent deposits) do not conflict; additionally, the executor atomically checks whether any
 * event matching `guardQuery` appeared after `guardPosition` before appending. `guardQuery` must
 * include only lifecycle event types (e.g. WalletOpened/WalletClosed) - NOT the event types being
 * appended - so concurrent commutative operations of the same type don't trigger spurious
 * conflicts (enforced below, matching CommandDecision.CommutativeGuarded's compact constructor).
 */
export interface CommutativeGuarded {
  readonly _tag: "CommutativeGuarded";
  readonly events: ReadonlyArray<AppendEvent>;
  readonly guardQuery: Query;
  readonly guardPosition: StreamPosition;
  readonly idempotencyKey: IdempotencyKey | null;
}

export const withLifecycleGuard = (
  event: AppendEvent,
  guardQuery: Query,
  guardPosition: StreamPosition
): CommutativeGuarded => {
  const appendedTypes = new Set([event.type]);
  const overlapping = guardQuery.items
    .flatMap((i) => i.eventTypes)
    .filter((t) => appendedTypes.has(t));
  if (overlapping.length > 0) {
    throw new Error(
      `CommutativeGuarded lifecycle query must not include appended event types: ${[...new Set(overlapping)].sort().join(", ")}`
    );
  }
  return { _tag: "CommutativeGuarded", events: [event], guardQuery, guardPosition, idempotencyKey: null };
};

export const commutativeGuardedIdempotent = (
  decision: CommutativeGuarded,
  eventType: string,
  tagKey: string,
  tagValue: string,
  onDuplicate?: OnDuplicate
): CommutativeGuarded => ({ ...decision, idempotencyKey: idempotencyKeyOf(eventType, tagKey, tagValue, onDuplicate) });

export type CommutativeDecision = Commutative | CommutativeGuarded;

// Non-commutative - stream-position-based DCB conflict check.
export interface NonCommutative {
  readonly _tag: "NonCommutative";
  readonly events: ReadonlyArray<AppendEvent>;
  readonly decisionModel: Query;
  readonly streamPosition: StreamPosition;
}

export const nonCommutative = (
  event: AppendEvent,
  decisionModel: Query,
  streamPosition: StreamPosition
): NonCommutative => ({ _tag: "NonCommutative", events: [event], decisionModel, streamPosition });

// Idempotent - entity creation; fails if an event with the same tag already exists.
export interface Idempotent {
  readonly _tag: "Idempotent";
  readonly events: ReadonlyArray<AppendEvent>;
  readonly eventType: string;
  readonly tagKey: string;
  readonly tagValue: string;
  readonly onDuplicate: OnDuplicate;
}

export const idempotent = (
  event: AppendEvent,
  eventType: string,
  tagKey: string,
  tagValue: string,
  onDuplicate: OnDuplicate = "RETURN_IDEMPOTENT"
): Idempotent => ({ _tag: "Idempotent", events: [event], eventType, tagKey, tagValue, onDuplicate });

// No operation needed (already applied) - CommandExecutor skips the append entirely.
export interface NoOp {
  readonly _tag: "NoOp";
  readonly reason: string | null;
}

export const noOp = (reason: string | null = null): NoOp => ({ _tag: "NoOp", reason });

export type CommandDecision = Commutative | CommutativeGuarded | NonCommutative | Idempotent | NoOp;

export const eventsOf = (decision: CommandDecision): ReadonlyArray<AppendEvent> =>
  decision._tag === "NoOp" ? [] : decision.events;
