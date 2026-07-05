import { Data } from "effect";

// Port of com.crablet.eventstore.DCBViolation - structured error detail from append_events_if().
export interface DCBViolation {
  readonly errorCode: string;
  readonly message: string;
  readonly matchingEventsCount: number;
}

// Port of com.crablet.eventstore.ConcurrencyException. A YieldableError (usable directly as an
// Effect failure via `yield* new ConcurrencyException(...)`), carrying the structured DCBViolation
// the same way Java's ConcurrencyException.violation field does.
//
// PATTERN PRIMER - `Data.TaggedError`, Effect's answer to Java's checked exceptions. Every
// `Effect<A, E, R>` has an explicit error type `E` right in its signature (see EventStore.ts's
// primer on the three type parameters) - `Data.TaggedError("ConcurrencyException")<{ ... }>` is a
// base-class factory that gives you, for free: (1) a class with the listed fields, (2) an
// automatic `readonly _tag: "ConcurrencyException"` discriminant field (so `Effect.catchTag(...)`
// and `switch (e._tag)` work, the same discriminated-union mechanism CommandDecision.ts uses), and
// (3) a class that's already shaped like an Effect failure, so `yield* new ConcurrencyException(...)`
// inside an `Effect.gen` block *is* "fail this Effect with this error" - no separate
// `Effect.fail(...)` wrapper needed. Compare to plain `class X extends Error` (which Effect can
// still carry as a failure, but without the `_tag` discriminant or the ergonomic constructor).
// Every typed error in this codebase (`ProgressTableNotReady` in event-poller's ProgressTracker.ts,
// etc.) follows this same pattern - this file is the primer; later ones just point back here.
export class ConcurrencyException extends Data.TaggedError("ConcurrencyException")<{
  readonly message: string;
  readonly violation: DCBViolation | null;
}> {}
