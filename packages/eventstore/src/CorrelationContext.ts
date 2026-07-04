import { Effect, FiberRef, Option } from "effect";

// Port of com.crablet.eventstore.CorrelationContext. Java uses ScopedValue (immutable within a
// scope, zero overhead when unbound); Effect's FiberRef is the direct equivalent - fiber-local,
// automatically restored when the modifying scope exits, no overhead when never set.
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
