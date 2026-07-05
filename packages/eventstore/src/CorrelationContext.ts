import { Effect, FiberRef, Option } from "effect";

// Port of com.crablet.eventstore.CorrelationContext. Java uses ScopedValue (immutable within a
// scope, zero overhead when unbound); Effect's FiberRef is the direct equivalent - fiber-local,
// automatically restored when the modifying scope exits, no overhead when never set.
//
// PATTERN PRIMER - `FiberRef<A>`: a mutable cell like `Ref<A>` (see event-poller's EventProcessor.ts
// for that primer), but scoped to the current *fiber* rather than being one single shared box.
// Every fiber effectively gets its own copy, inherited from its parent at fork time - so setting a
// value inside one command's execution doesn't leak into a sibling fiber running a different
// command concurrently. `Effect.locally(ref, value)(effect)` (used below in
// `withCorrelationId`/`withCausationId`) temporarily overrides the value for the duration of
// `effect` only, then restores whatever it was before - this is what makes it "ambient": any code
// deep inside that `effect` (e.g. `internal/sql.ts`'s `appendEventsIf`, several call-frames away,
// with no explicit parameter threading it through) can just `yield* correlationId` and get the
// right value, the same way Java's `ScopedValue.get()` works inside a `ScopedValue.where(...).run(...)`
// block. `Option.none()`/`Option.some(...)` (not `null`/undefined-checks) is Effect's standard
// "value or absent" type - pattern-matched here via `Option.getOrNull` at the read site.
const correlationIdRef = FiberRef.unsafeMake<Option.Option<string>>(Option.none());
const causationIdRef = FiberRef.unsafeMake<Option.Option<bigint>>(Option.none());

export const correlationId: Effect.Effect<string | null> = Effect.map(
  FiberRef.get(correlationIdRef),
  Option.getOrNull
);

export const causationId: Effect.Effect<bigint | null> = Effect.map(
  FiberRef.get(causationIdRef),
  Option.getOrNull
);

export const withCorrelationId =
  (correlationIdValue: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.locally(correlationIdRef, Option.some(correlationIdValue))(effect);

export const withCausationId =
  (causationIdValue: bigint) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.locally(causationIdRef, Option.some(causationIdValue))(effect);
