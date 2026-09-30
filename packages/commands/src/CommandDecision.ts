import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import * as AppendCondition from "@crablet/eventstore/AppendCondition";
import type { AppendCondition as AppendConditionType } from "@crablet/eventstore/AppendCondition";
import * as Query from "@crablet/eventstore/Query";
import type { Query as QueryType } from "@crablet/eventstore/Query";
import type { LogPosition } from "@crablet/eventstore/LogPosition";

// What a command handler hands back to the executor: either "append these events, under this
// condition" or "nothing to do".
//
// PATTERN PRIMER - "discriminated union", TypeScript's closed set of variants: each variant is a
// plain interface with a `readonly _tag: "SomeLiteralString"` field - a *literal* string type, not
// just `string`, so TypeScript can narrow on it. `CommandExecutor.ts`'s `switch (decision._tag)`
// gets exhaustiveness checking for free: if a variant is ever added without a matching `case`, the
// switch becomes a type error rather than a silent runtime gap. This same `_tag` mechanism is what
// `Data.TaggedError` generates for error types (see eventstore's AppendErrors.ts).

// What to do when the idempotency check finds the operation was already done: report it as a
// successful "idempotent" result (the default, safe for retries), or fail with `Duplicate`.
export type OnDuplicate = "THROW" | "RETURN_IDEMPOTENT";

// Every way of appending is one shape: events plus an `AppendCondition`. The condition carries the
// two independent checks the SQL append supports - a concurrency check (was anything matching
// `concurrencyQuery` appended after `afterPosition`?) and an idempotency check (does anything
// matching `idempotencyQuery` already exist?) - and any combination is valid, including strict AND
// idempotent. The helper constructors below are just named ways of building the condition.
export interface Append {
  readonly _tag: "Append";
  readonly events: ReadonlyArray<AppendEvent>;
  readonly condition: AppendConditionType;
  readonly onDuplicate: OnDuplicate;
  // Which kind of `Conflict` the executor reports if the concurrency check refuses the append:
  // "boundary" when the condition is the decision model itself, "guard" when it is a lifecycle
  // guard on an otherwise commutative command.
  readonly conflictKind: "boundary" | "guard";
}

export interface NoOp {
  readonly _tag: "NoOp";
  readonly reason: string | null;
}

export type CommandDecision = Append | NoOp;

const eventList = (events: AppendEvent | ReadonlyArray<AppendEvent>): ReadonlyArray<AppendEvent> =>
  Array.isArray(events) ? events : [events as AppendEvent];

const make = (
  events: ReadonlyArray<AppendEvent>,
  condition: AppendConditionType,
  conflictKind: "boundary" | "guard" = "boundary"
): Append => ({ _tag: "Append", events, condition, onDuplicate: "RETURN_IDEMPOTENT", conflictKind });

// Commutative: safe to run in parallel with itself - no concurrency check at all.
export const commutative = (...events: ReadonlyArray<AppendEvent>): Append => make(events, AppendCondition.empty());

// Add an idempotency check to ANY append (commutative, guarded or strict): refuse, or report
// "already done", if an event of `eventType` tagged `tagKey=tagValue` already exists. The check runs
// before the concurrency check, so a retry after the state has moved on is "already done", not a
// spurious conflict.
export const withIdempotency = (
  decision: Append,
  eventType: string,
  tagKey: string,
  tagValue: string,
  onDuplicate: OnDuplicate = "RETURN_IDEMPOTENT"
): Append => {
  if (!eventType.trim()) throw new Error("idempotency eventType must not be blank");
  if (!tagKey.trim()) throw new Error("idempotency tagKey must not be blank");
  if (!tagValue.trim()) throw new Error("idempotency tagValue must not be blank");
  return {
    ...decision,
    condition: { ...decision.condition, idempotencyQuery: Query.forEventAndTag(eventType, tagKey, tagValue) },
    onDuplicate
  };
};

// Earlier names for the same operation, kept until defineCommand replaces hand-written handlers.
export const commutativeIdempotent = withIdempotency;
export const commutativeGuardedIdempotent = withIdempotency;

// Commutative with a selective lifecycle guard. Parallel operations of the same type (e.g.
// concurrent deposits) do not conflict; additionally the append atomically checks whether any event
// matching `guardQuery` appeared after `logPosition`. `guardQuery` must include only lifecycle
// event types (e.g. WalletOpened/WalletClosed) - NOT the event types being appended - otherwise
// concurrent operations of the same type would conflict with each other.
export const withLifecycleGuard = (
  events: AppendEvent | ReadonlyArray<AppendEvent>,
  guardQuery: QueryType,
  logPosition: LogPosition
): Append => {
  const list = eventList(events);
  const appendedTypes = new Set(list.map((e) => e.type));
  const overlapping = guardQuery.items.flatMap((i) => i.eventTypes).filter((t) => appendedTypes.has(t));
  if (overlapping.length > 0) {
    throw new Error(
      `Lifecycle guard query must not include appended event types: ${[...new Set(overlapping)].sort().join(", ")}`
    );
  }
  return make(list, AppendCondition.of(logPosition, guardQuery), "guard");
};

// Non-commutative (strict): refuse the append if ANYTHING matching the decision model was appended
// after `logPosition` - the decision was made on state that is no longer current.
export const nonCommutative = (
  events: AppendEvent | ReadonlyArray<AppendEvent>,
  decisionModel: QueryType,
  logPosition: LogPosition
): Append => make(eventList(events), AppendCondition.of(logPosition, decisionModel));

// Idempotency only (no concurrency check): append unless an event of `eventType` tagged
// `tagKey=tagValue` already exists.
export const idempotent = (
  events: AppendEvent | ReadonlyArray<AppendEvent>,
  eventType: string,
  tagKey: string,
  tagValue: string,
  onDuplicate: OnDuplicate = "RETURN_IDEMPOTENT"
): Append => withIdempotency(commutative(...eventList(events)), eventType, tagKey, tagValue, onDuplicate);

export const noOp = (reason: string | null = null): NoOp => ({ _tag: "NoOp", reason });

export const eventsOf = (decision: CommandDecision): ReadonlyArray<AppendEvent> =>
  decision._tag === "NoOp" ? [] : decision.events;
