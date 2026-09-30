import { Data } from "effect";

// The two ways a conditional append can be refused. Both are typed failures in the `E` channel.
//
// - `Conflict`: something matching the condition's concurrency query was appended after the
//   position the decision was made at, so the decision may be stale. `kind` says which check
//   tripped: "boundary" (the decision model itself changed) or "guard" (a lifecycle guard on an
//   otherwise commutative command changed). Usually the right response is to reload and retry.
// - `Duplicate`: an event matching the condition's idempotency query already exists - the same
//   operation was already done. Whether that is an error or a silent "already done" is the
//   command's `onDuplicate` policy (see commands' CommandDecision.ts), not this module's call.
//
// PATTERN PRIMER - `Data.TaggedError`, Effect's answer to Java-style checked exceptions. Every
// `Effect<A, E, R>` has an explicit error type `E` right in its signature (see EventStore.ts's
// primer on the three type parameters) - `Data.TaggedError("Conflict")<{ ... }>` is a base-class
// factory that gives you, for free: (1) a class with the listed fields, (2) an automatic
// `readonly _tag: "Conflict"` discriminant field (so `Effect.catchTag("Conflict", ...)` and
// `switch (e._tag)` work, the same discriminated-union mechanism CommandDecision.ts uses), and (3) a
// class that is already shaped like an Effect failure, so `yield* new Conflict(...)` inside an
// `Effect.gen` block *is* "fail this Effect with this error" - no separate `Effect.fail(...)`
// wrapper needed. Every typed error in this codebase follows this same pattern.
export class Conflict extends Data.TaggedError("Conflict")<{
  readonly message: string;
  readonly kind: "boundary" | "guard";
}> {}

export class Duplicate extends Data.TaggedError("Duplicate")<{
  readonly message: string;
}> {}
