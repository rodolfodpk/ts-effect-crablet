import { Context, Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import type { Tag } from "./Tag.ts";
import type { AppendEvent } from "./AppendEvent.ts";
import * as AppendConditionNS from "./AppendCondition.ts";
import type { AppendCondition } from "./AppendCondition.ts";
import * as QueryNS from "./Query.ts";
import type { Query } from "./Query.ts";
import * as StreamPositionNS from "./StreamPosition.ts";
import type { StreamPosition } from "./StreamPosition.ts";
import type { ConcurrencyException } from "./DCBViolation.ts";
import { encodePayload } from "./NotifyPayload.ts";
import * as Sql from "./internal/sql.ts";

// Port of PostgresNotifyWakeupSource.CHANNEL's default - the fixed channel every append notifies
// on and every LISTEN/NOTIFY-based consumer (event-poller's wakeupStream) subscribes to.
export const EVENTS_CHANNEL = "crablet_events";

// Port of com.crablet.eventstore.StoredEvent - a queried event (as opposed to AppendEvent, which
// is what's written).
export interface StoredEvent {
  readonly type: string;
  readonly tags: ReadonlyArray<Tag>;
  readonly data: unknown;
  readonly transactionId: string;
  readonly position: bigint;
  readonly occurredAt: Date;
  readonly correlationId: string | null;
  readonly causationId: bigint | null;
}

// Port of com.crablet.eventstore.query.StateProjector<T>. eventTypes empty = matches all types
// (mirrors StateProjector.exists()'s "no filter" semantics).
export interface StateProjector<T> {
  readonly eventTypes: ReadonlyArray<string>;
  readonly initialState: T;
  transition(state: T, event: StoredEvent): T;
}

export const existsProjector = (...eventTypes: ReadonlyArray<string>): StateProjector<boolean> => ({
  eventTypes,
  initialState: false,
  transition: () => true
});

export interface ProjectionResult<T> {
  readonly state: T;
  readonly streamPosition: StreamPosition;
}

// PATTERN PRIMER - `Effect.Effect<A, E, R>`, the type every function in this codebase returns
// instead of a bare value, a `Promise`, or a value-that-might-throw. Read it as three independent
// promises the type makes to callers:
//   A - what you get back on success (a Promise<A> in async/await terms)
//   E - the *typed* ways this can fail (see DCBViolation.ts's primer on Data.TaggedError) - unlike
//       a thrown JS error, E shows up in the signature, so the compiler forces callers to handle
//       or explicitly propagate it. `never` here means "cannot fail with a typed error."
//   R - what ambient services/capabilities this computation needs before it can run at all (see
//       this file's own `Context.Tag`/`Layer.effect` primer just below) - `never` means "needs
//       nothing, runs anywhere."
// Nothing actually *runs* just by writing `Effect.Effect<...>` - it's a lazy, immutable
// description of a computation (like an un-awaited `Promise` factory, but re-runnable and
// inspectable). `appendCommutative` below promises: give me events, you'll either get a
// transaction id back (A = string), or it will fail with a Postgres error (E = SqlError), and it
// needs nothing else from the caller (R = never, since the concrete `sql` client is captured
// inside `EventStoreLive` below, not passed in per-call).
export interface EventStoreService {
  readonly appendCommutative: (events: ReadonlyArray<AppendEvent>) => Effect.Effect<string, SqlError>;

  readonly appendNonCommutative: (
    events: ReadonlyArray<AppendEvent>,
    decisionModel: Query,
    streamPosition: StreamPosition
  ) => Effect.Effect<string, ConcurrencyException | SqlError>;

  readonly appendIdempotent: (
    events: ReadonlyArray<AppendEvent>,
    eventType: string,
    tagKey: string,
    tagValue: string
  ) => Effect.Effect<string, ConcurrencyException | SqlError>;

  // Low-level, fully general append - the atomic primitive appendNonCommutative/appendIdempotent
  // are built on. Prefer the semantic methods for typical use.
  readonly appendConditional: (
    events: ReadonlyArray<AppendEvent>,
    condition: AppendCondition
  ) => Effect.Effect<string, ConcurrencyException | SqlError>;

  readonly project: <T>(
    query: Query,
    after: StreamPosition,
    projectors: ReadonlyArray<StateProjector<T>>
  ) => Effect.Effect<ProjectionResult<T>, SqlError>;

  readonly exists: (query: Query) => Effect.Effect<boolean, SqlError>;
}

// PATTERN PRIMER - `Context.Tag` + `Layer.effect`, the Effect equivalent of a Spring `@Service`
// bean plus its dependency-injection wiring, split into two halves:
//
// 1. `Context.Tag("EventStore")<EventStore, EventStoreService>()` creates an *identity token* -
//    a unique key that lets Effect's context map "EventStore" to a concrete `EventStoreService`
//    value at runtime. Extending it as a `class EventStore` (rather than just calling the
//    function and assigning the result to a `const`) is a convenience: the class itself becomes
//    both the runtime token *and* the compile-time type you write elsewhere (`Effect<..., ...,
//    EventStore>` in the `R` position - see the `Effect<A,E,R>` primer above). Any code that
//    writes `yield* EventStore` inside an `Effect.gen` block (e.g. CommandExecutor.ts) is asking
//    Effect's context for whatever concrete implementation was registered under this token - it
//    never sees or imports `EventStoreLive` directly. This is the DI: callers depend on the
//    *interface* (`EventStoreService`), never the implementation.
// 2. `Layer.effect(EventStore, someEffect)` (below) is the *registration* - "when something asks
//    for the `EventStore` token, run this Effect once to build the real implementation, and reuse
//    that instance." A `Layer` is itself just a description (like `Effect` is) until something
//    provides it into a runnable program (see `Layer.provide`/`Layer.provideMerge`/`ManagedRuntime`
//    used throughout the test files) - that's the "wiring" step, analogous to Spring's application
//    context assembling all `@Service` beans together at startup.
export class EventStore extends Context.Tag("EventStore")<EventStore, EventStoreService>() {}

function parseRow(row: Sql.StoredEventRow): StoredEvent {
  const tags: ReadonlyArray<Tag> = row.tags.map((raw) => {
    const idx = raw.indexOf("=");
    return idx < 0 ? { key: raw, value: "" } : { key: raw.slice(0, idx), value: raw.slice(idx + 1) };
  });
  return {
    type: row.type,
    tags,
    data: row.data,
    transactionId: row.transaction_id,
    position: BigInt(row.position),
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id === null ? null : BigInt(row.causation_id)
  };
}

// Effect's transaction handling is ambient (SqlClient.withTransaction scopes every SqlClient call
// made within its callback to one transaction), so - unlike Java's EventStoreImpl needing a
// separate ConnectionScopedEventStore for the transaction-scoped case - a single implementation
// works for both standalone and transaction-scoped use. Whatever SqlClient is in the current
// Effect context (direct pool connection, or the transaction-bound one inside withTransaction)
// is what these methods use.
// PATTERN PRIMER - `Effect.gen(function* () { ... })` + `yield*` is this codebase's direct
// substitute for `async function () { ... }` + `await`. Every `yield* someEffect` line below
// "runs" `someEffect` and binds its success value to a variable, exactly like `await somePromise`
// would - except (a) nothing runs until the whole `Effect.gen(...)` block itself is executed by
// something further up the chain (it's lazy, like every `Effect`), (b) if `someEffect`'s error
// type `E` is not `never`, a failure short-circuits the rest of the generator *and* that failure
// is tracked in the enclosing function's own `E` (TypeScript infers the union of every yielded
// effect's error type - this is what replaces `try`/`catch` for the common case), and (c) if
// `someEffect` needs some ambient service (`R` not `never`), that requirement is inferred onto the
// enclosing function too, until something calls `Effect.provide`/`Layer.effect`'s own machinery to
// satisfy it. `yield* SqlClient.SqlClient` just below is exactly this: "ask the ambient context
// for the SqlClient service" (compare to a Java method needing a `DataSource` injected via
// constructor - here it's requested inline, right where it's needed, and TypeScript tracks that
// requirement in the enclosing function's `R` type parameter automatically).
export const EventStoreLive = Layer.effect(
  EventStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const project = <T>(
      query: Query,
      after: StreamPosition,
      projectors: ReadonlyArray<StateProjector<T>>
    ): Effect.Effect<ProjectionResult<T>, SqlError> =>
      Effect.gen(function* () {
        if (projectors.length === 0) {
          return yield* Effect.die("At least one projector is required");
        }
        const rows = yield* Sql.queryEvents(sql, query, after);

        let state = projectors[0]!.initialState;
        let lastStreamPosition = after;

        for (const row of rows) {
          const event = parseRow(row);
          for (const projector of projectors) {
            if (projector.eventTypes.length === 0 || projector.eventTypes.includes(event.type)) {
              state = projector.transition(state, event);
            }
          }
          lastStreamPosition = StreamPositionNS.of(event.position, event.occurredAt, event.transactionId);
        }

        return { state: state as T, streamPosition: lastStreamPosition };
      });

    const exists = (query: Query): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        project(query, StreamPositionNS.zero(), [existsProjector()]),
        (r) => r.state
      );

    const appendConditional = (
      events: ReadonlyArray<AppendEvent>,
      condition: AppendCondition
    ): Effect.Effect<string, ConcurrencyException | SqlError> => {
      if (events.length === 0) {
        return Effect.die("Cannot append empty events list");
      }
      const eventTypes = new Set(events.map((e) => e.type));
      const tagKeys = new Set(events.flatMap((e) => e.tags.map((t) => t.key)));
      return Sql.appendEventsIf(sql, events, condition, {
        notifyChannel: EVENTS_CHANNEL,
        notifyPayload: encodePayload(eventTypes, tagKeys)
      });
    };

    const service: EventStoreService = {
      // AppendCondition.empty() has empty concurrency/idempotency queries, which append_events_if()
      // short-circuits to FALSE without evaluating any check (verified against the SQL function) -
      // ConcurrencyException genuinely cannot occur here. Narrowing the type reflects that
      // runtime guarantee; Java's appendCommutative signature makes the same claim.
      appendCommutative: (events) =>
        appendConditional(events, AppendConditionNS.empty()) as Effect.Effect<string, SqlError>,

      appendNonCommutative: (events, decisionModel, streamPosition) =>
        appendConditional(events, AppendConditionNS.of(streamPosition, decisionModel)),

      appendIdempotent: (events, eventType, tagKey, tagValue) =>
        appendConditional(events, AppendConditionNS.idempotent(eventType, tagKey, tagValue)),

      appendConditional,
      project,
      exists
    };

    return service;
  })
);
