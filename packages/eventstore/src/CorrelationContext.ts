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

// Set by the command executor around a command's transaction: its append must be the transaction's first write, so its events sort after
// everything the command read (ADR-0033). `appendEventsIf` passes it to the database, which refuses a transaction that already wrote.
const FreshTransaction = Context.Reference<boolean>("crablet/RequireFreshTransaction", {
  defaultValue: () => false
});

// Set by the command executor around the append of a command with an idempotency key: the request's fingerprint (hex SHA-256), stored on
// its events and compared when the key repeats (ADR-0034).
const RequestFingerprint = Context.Reference<string | null>("crablet/RequestFingerprint", {
  defaultValue: () => null
});

// Set around appends with `withMetadata` (AppendContext.ts): the client's metadata added to every event appended inside (ADR-0051).
const Metadata = Context.Reference<Readonly<Record<string, unknown>> | null>("crablet/Metadata", {
  defaultValue: () => null
});

export const metadata: Effect.Effect<Readonly<Record<string, unknown>> | null> = Effect.gen(function* () {
  return yield* Metadata;
});

// Within `effect`, `extra` is added to the metadata of every event appended (keys set closer in win: an inner `withMetadata`, then the event's own).
export const withMetadata =
  (extra: Readonly<Record<string, unknown>>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(metadata, (outer) => Effect.provideService(effect, Metadata, { ...(outer ?? {}), ...extra }));

// Each event's metadata as stored: the context's, then the event's own; null when neither has any.
export const metadataOf = (
  events: ReadonlyArray<{ readonly metadata?: Readonly<Record<string, unknown>> }>,
  context: Readonly<Record<string, unknown>> | null
): ReadonlyArray<Readonly<Record<string, unknown>> | null> =>
  events.map((e) => (context === null && e.metadata === undefined ? null : { ...(context ?? {}), ...(e.metadata ?? {}) }));

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

export const requiresFreshTransaction: Effect.Effect<boolean> = Effect.gen(function* () {
  return yield* FreshTransaction;
});

export const requireFreshTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, FreshTransaction, true);

export const requestFingerprint: Effect.Effect<string | null> = Effect.gen(function* () {
  return yield* RequestFingerprint;
});

export const withRequestFingerprint =
  (fingerprint: string | null) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, RequestFingerprint, fingerprint);
