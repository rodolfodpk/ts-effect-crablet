import { Data } from "effect";

// The two ways a conditional append can be refused. Both are typed failures in the `E` channel.
//
// - `Conflict`: something matching the condition's concurrency query was appended after the
//   position the decision was made at, so the decision may be stale. `kind` says which check
//   tripped: "boundary" (the decision model itself changed) or "guard" (a lifecycle guard on an
//   otherwise commutative command changed). Usually the right response is to reload and retry.
// - `Duplicate`: an event matching the condition's idempotency query already exists - the same
//   operation was already done. It says what it matched: the latest matching event (a marker a repeat can answer with) and the
//   requests behind the matches (their fingerprints and causes), so the command executor can tell the same request, which is an
//   idempotent success ("already done"), from a different one under the same key (ADR-0034). Only a caller of `EventStore.append`
//   itself sees this error.
//
// PATTERN PRIMER - `Data.TaggedError`, Effect's typed, checked-exception-like errors. Every
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

// One request behind a match: the fingerprint its command stored (null for an event appended without one) and the event that caused it
// (an automation's trigger; null for a request from outside).
export interface MatchedRequest {
  readonly fingerprint: string | null;
  readonly causationId: bigint | null;
}

export class Duplicate extends Data.TaggedError("Duplicate")<{
  readonly message: string;
  // The latest matching event, in (transaction_id, position) order.
  readonly latest: { readonly position: bigint; readonly transactionId: string };
  // The distinct requests behind the matches (at most a few).
  readonly requests: ReadonlyArray<MatchedRequest>;
  // True when the idempotency query did NOT see it and the database's backstop did: the same trigger appending the same request again (ADR-0035).
  // It means the command's `idempotentBy` does not recognise its own repeat.
  readonly byTrigger: boolean;
}> {}

// An append of more events than `MAX_APPEND_EVENTS`. One append is one transaction that takes the writer lock and notifies once, so a very large batch holds
// every other writer back for as long as it takes. It is refused before any SQL runs; split the work into several appends (each is atomic on its own).
export const MAX_APPEND_EVENTS = 50;

export class AppendTooLarge extends Data.TaggedError("AppendTooLarge")<{
  readonly message: string;
  readonly count: number;
  readonly max: number;
}> {}
