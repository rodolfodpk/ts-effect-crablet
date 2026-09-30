import { Context, Effect } from "effect";

// Ambient correlation/causation ids: a `Context.Reference` is a service with a default value, so any
// code deep inside an effect (e.g. `internal/sql.ts`'s `appendEventsIf`, several call-frames away,
// with no explicit parameter threading it through) can just `yield* correlationId` and get the value
// set by an enclosing `withCorrelationId(...)`, and gets `null` when nothing set one.
//
// PATTERN PRIMER - `Context.Reference<A>(id, { defaultValue })`: like a service tag, but reading it
// never fails for a missing service - it falls back to `defaultValue`. Values live in the fiber's
// context, which child fibers inherit at fork time, so setting one for a command's execution does not
// leak into a sibling fiber running a different command. `Effect.provideService(effect, ref, value)`
// (used below) overrides the value for the duration of `effect` only; afterwards the previous value
// is back. Inside `Effect.gen`, `yield* someReference` reads the current value.
const CorrelationId = Context.Reference<string | null>("crablet/CorrelationId", {
  defaultValue: () => null
});
const CausationId = Context.Reference<bigint | null>("crablet/CausationId", {
  defaultValue: () => null
});

export const correlationId: Effect.Effect<string | null> = Effect.gen(function* () {
  return yield* CorrelationId;
});

export const causationId: Effect.Effect<bigint | null> = Effect.gen(function* () {
  return yield* CausationId;
});

export const withCorrelationId =
  (correlationIdValue: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, CorrelationId, correlationIdValue);

export const withCausationId =
  (causationIdValue: bigint) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, CausationId, causationIdValue);
