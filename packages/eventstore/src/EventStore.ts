import { Context, Effect, Layer, Metric } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import * as EventStoreMetrics from "@crablet/metrics-otel/EventStoreMetrics";
import { EventDecodingFailure, decodingErrorOf, reportDecodingError, type EventDecodingError } from "./EventDecoding.ts";
import type { Tag } from "./Tag.ts";
import type { AppendEvent } from "./AppendEvent.ts";
import type { AppendResult } from "./AppendResult.ts";
import * as AppendConditionNS from "./AppendCondition.ts";
import type { AppendCondition } from "./AppendCondition.ts";
import * as QueryNS from "./Query.ts";
import type { Query } from "./Query.ts";
import * as LogPositionNS from "./LogPosition.ts";
import type { LogPosition } from "./LogPosition.ts";
import { Conflict, Duplicate } from "./AppendErrors.ts";
import { encodePayload } from "./NotifyPayload.ts";
import * as Sql from "./internal/sql.ts";

// The fixed channel every append notifies
// on and every LISTEN/NOTIFY-based consumer (event-poller's wakeupStream) subscribes to.
export const EVENTS_CHANNEL = "crablet_events";

// A queried event (as opposed to AppendEvent, which
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

// eventTypes empty = matches all types ("no filter" semantics).
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
  readonly logPosition: LogPosition;
  // A cursor that sorts before every event this read could have MISSED (an event whose transaction had not finished when it read), so an append
  // condition using it can never skip one. In Postgres: `(xmin of a snapshot taken before the read, 0)`: a read sees every event whose
  // transaction id is below its xmin. A model over several entities uses the earliest of its members' horizons (ADR-0018, decision 8).
  readonly horizon: LogPosition;
  // The state as of `logPosition` only: events the read saw but that were not settled yet are folded into `state` (a command decides on them, and the
  // append condition then reports them as a conflict), but they sit above the cursor, so a snapshot of `state` taken at `logPosition` would count them
  // again on the next load. A snapshot stores this one.
  readonly settledState: T;
}

// PATTERN PRIMER - `Effect.Effect<A, E, R>`, the type every function in this codebase returns
// instead of a bare value, a `Promise`, or a value-that-might-throw. Read it as three independent
// promises the type makes to callers:
//   A - what you get back on success (a Promise<A> in async/await terms)
//   E - the *typed* ways this can fail (see AppendErrors.ts's primer on Data.TaggedError) - unlike
//       a thrown JS error, E shows up in the signature, so the compiler forces callers to handle
//       or explicitly propagate it. `never` here means "cannot fail with a typed error."
//   R - what ambient services/capabilities this computation needs before it can run at all (see
//       this file's own `Context.Service`/`Layer.effect` primer just below) - `never` means "needs
//       nothing, runs anywhere."
// Nothing actually *runs* just by writing `Effect.Effect<...>` - it's a lazy, immutable
// description of a computation (like an un-awaited `Promise` factory, but re-runnable and
// inspectable). `append` below promises: give me events, you'll either get a
// transaction id back (A = string), or it will fail with a Postgres error (E = SqlError), and it
// needs nothing else from the caller (R = never, since the concrete `sql` client is captured
// inside `EventStoreLive` below, not passed in per-call).
export interface EventStoreService {
  // The one write primitive: append `events` atomically, optionally guarded by an `AppendCondition`
  // (a concurrency check after a log position, and/or an idempotency check - see AppendCondition.ts).
  // Without a condition nothing can be refused, so the only failure is a database error; with one,
  // the append can also be refused with `Conflict` (something matching the concurrency query is newer
  // than the position the decision was made at) or `Duplicate` (the idempotency query already matches).
  readonly append: {
    (events: ReadonlyArray<AppendEvent>): Effect.Effect<AppendResult, SqlError>;
    (
      events: ReadonlyArray<AppendEvent>,
      condition: AppendCondition
    ): Effect.Effect<AppendResult, Conflict | Duplicate | SqlError>;
  };

  readonly project: <T>(
    query: Query,
    after: LogPosition,
    projectors: ReadonlyArray<StateProjector<T>>
  ) => Effect.Effect<ProjectionResult<T>, SqlError | EventDecodingError>;

  readonly exists: (query: Query) => Effect.Effect<boolean, SqlError>;
}

// PATTERN PRIMER - `Context.Service` + `Layer.effect`, the Effect equivalent of a Spring `@Service`
// bean plus its dependency-injection wiring, split into two halves:
//
// 1. `Context.Service<EventStore, EventStoreService>()("EventStore")` creates an *identity token* -
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
export class EventStore extends Context.Service<EventStore, EventStoreService>()("EventStore") {}

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
// made within its callback to one transaction), so a single implementation
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
// for the SqlClient service" (it's requested inline, right where it's needed, and TypeScript tracks that
// requirement in the enclosing function's `R` type parameter automatically).
export const EventStoreLive = Layer.effect(
  EventStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const project = <T>(
      query: Query,
      after: LogPosition,
      projectors: ReadonlyArray<StateProjector<T>>
    ): Effect.Effect<ProjectionResult<T>, SqlError | EventDecodingError> =>
      Effect.gen(function* () {
        if (projectors.length === 0) {
          return yield* Effect.die("At least one projector is required");
        }
        // BEFORE the read: xmin never decreases, so this one is never above the read's own snapshot's (and a lower one is only more cautious).
        const xmin = yield* Sql.currentXmin(sql);
        const rows = yield* Sql.queryEvents(sql, query, after);

        let state = projectors[0]!.initialState;
        let settledState = state;
        let lastLogPosition = after;

        for (const row of rows) {
          const event = parseRow(row);
          for (const projector of projectors) {
            if (projector.eventTypes.length === 0 || projector.eventTypes.includes(event.type)) {
              try {
                state = projector.transition(state, event);
              } catch (error) {
                // A stored event its definition cannot read (ADR-0017): a typed failure that names it, not a defect, and never a skip.
                if (!(error instanceof EventDecodingFailure)) throw error;
                return yield* reportDecodingError(decodingErrorOf(error, event));
              }
            }
          }
          // The cursor only advances over SETTLED events (their transaction had finished when we read): an
          // event that commits later can have a lower position than one we loaded, but never a lower
          // (transaction_id, position) than the last settled one. A loaded-but-unsettled event stays above the
          // cursor, so the append condition reports it as a conflict and the command is retried with it settled.
          if (row.settled !== false) {
            lastLogPosition = LogPositionNS.of(event.position, event.occurredAt, event.transactionId);
            settledState = state;
          }
        }

        return { state: state as T, settledState: settledState as T, logPosition: lastLogPosition, horizon: { position: 0n, occurredAt: null, transactionId: xmin } };
      });

    const exists = (query: Query): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        // `existsProjector` never decodes a payload, so no decoding error can come out of it
        Effect.catchTag(project(query, LogPositionNS.zero(), [existsProjector()]), "EventDecodingError", (e) => Effect.die(e)),
        (r) => r.state
      );

    // Instrumented once here, at the single write primitive.
    const appendWith = (
      events: ReadonlyArray<AppendEvent>,
      condition: AppendCondition
    ): Effect.Effect<AppendResult, Conflict | Duplicate | SqlError> => {
      if (events.length === 0) {
        return Effect.die("Cannot append empty events list");
      }
      const eventTypes = new Set(events.map((e) => e.type));
      const tagKeys = new Set(events.flatMap((e) => e.tags.map((t) => t.key)));
      return EventStoreMetrics.observe(
        EventStoreMetrics.append,
        Sql.appendEventsIf(sql, events, condition, {
          notifyChannel: EVENTS_CHANNEL,
          notifyPayload: encodePayload(eventTypes, tagKeys)
        }).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              yield* Metric.update(EventStoreMetrics.eventsAppended, events.length);
              for (const type of eventTypes) {
                yield* Metric.update(Metric.withAttributes(EventStoreMetrics.eventTypeAppended, { event_type: type }), 1);
              }
            })
          ),
          // A dedicated counter alongside the generic append.failures `observe` already records,
          // for the failure mode operators care about most: a stale decision.
          Effect.catchTag("Conflict", (e) =>
            Effect.andThen(Metric.update(EventStoreMetrics.concurrencyViolations, 1), Effect.fail(e))
          )
        )
      );
    };

    // With no condition (AppendCondition.empty(): empty concurrency and idempotency queries, which
    // append_events_if() skips without evaluating any check) nothing can be refused, so the narrower
    // `SqlError`-only type of the first overload is a runtime guarantee, not just a convenience.
    const append = ((events: ReadonlyArray<AppendEvent>, condition?: AppendCondition) =>
      appendWith(events, condition ?? AppendConditionNS.empty())) as EventStoreService["append"];

    const service: EventStoreService = { append, project, exists };

    return service;
  })
);
