import { Context, Effect, Layer, Metric, Option, Stream } from "effect";
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
import * as ReadSnapshot from "./ReadSnapshot.ts";
import * as TagCodec from "./TagCodec.ts";
import * as Cursor from "./Cursor.ts";
import { AppendTooLarge, Conflict, Duplicate, maxAppendEventsOf } from "./AppendErrors.ts";
import * as Sql from "./internal/sql.ts";
import { makeWakeupNotifier, PendingWakeups } from "./internal/WakeupNotifier.ts";
import { pageSizeOf, refusingEmptyItems, refusingNoItems, withDistinctTags } from "./internal/guards.ts";

// The fixed channel every append notifies
// on and every LISTEN/NOTIFY-based consumer (event-poller's wakeupStream) subscribes to.
export const EVENTS_CHANNEL = "crablet_events";

// A queried event (as opposed to AppendEvent, which
// is what's written).
export interface StoredEvent {
  // The event's stable public id (a uuidv7): what a sink is given as the message id, the same on every republish (ADR-0036). NOT an order:
  // events are ordered by (transactionId, position), and an id sorts by when it was generated.
  readonly eventId: string;
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
  // What this read could see: the snapshot taken just before it (Postgres only). An append condition that carries it counts as a conflict only an
  // event this read could not see (ADR-0048). Taken BEFORE the read, so it never sees more than the read did. Absent in the in-memory store.
  readonly seen?: ReadSnapshot.ReadSnapshot;
  // The newest event this read returned, settled or not (the read's start when it returned none): an upper bound on what the read
  // saw, which `logPosition` (the last SETTLED one) is not. A command that decides "already done" from what it read answers with it as
  // its marker, so a reader that waits for it sees the earlier write (ADR-0034).
  readonly latest: LogPosition;
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
    (events: ReadonlyArray<AppendEvent>): Effect.Effect<AppendResult, AppendTooLarge | SqlError>;
    (
      events: ReadonlyArray<AppendEvent>,
      condition: AppendCondition
    ): Effect.Effect<AppendResult, AppendTooLarge | Conflict | Duplicate | SqlError>;
  };

  readonly project: <T>(
    query: Query,
    after: LogPosition,
    projectors: ReadonlyArray<StateProjector<T>>
  ) => Effect.Effect<ProjectionResult<T>, SqlError | EventDecodingError>;

  readonly exists: (query: Query) => Effect.Effect<boolean, SqlError>;

  // What an idempotency query matches, as the `Duplicate` an append with that query would fail with, or null when it matches nothing. The
  // command executor checks it before deciding, so a repeat is answered without running the command again (ADR-0034).
  readonly findDuplicate: (query: Query) => Effect.Effect<Duplicate | null, SqlError>;

  // Runs `effect` and, once it has SUCCEEDED, sends the wake-up for every event it appended (ADR-0021). Put it OUTSIDE the transaction that commits those events: the
  // notification must go out after the commit, or a poller wakes, finds nothing and sleeps. `CommandExecutor` does this for every command attempt. An application that appends
  // inside a transaction of its own wraps that transaction: `eventStore.withWakeups(sql.withTransaction(...))`. If `effect` fails nothing is sent. An `append` made outside any
  // `withWakeups` sends its wake-up when it returns. With `wakeupMode: "off"` this is the identity.
  readonly withWakeups: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

  // One page of the events `query` matches after `after` (from the start without it), in (transaction id, position) order, at most `limit` (1000
  // unless set). Only events whose transaction had finished, so resuming from `cursor` never skips one; `more` is true when the page is full. `more:
  // false` means no more finished events now: one still being written shows up in a later read, and an open transaction anywhere holds the page
  // back to before it, as for the processors (ADR-0050). A query with no items is refused: every event is `Query.all()`.
  readonly read: (query: Query, options?: ReadOptions) => Effect.Effect<ReadPage, SqlError>;

  // Runs `effect` in one database transaction and sends the wake-ups of what it appended once it has committed (withWakeups around
  // sql.withTransaction, in the right order). A failure rolls everything back and announces nothing (ADR-0050). In memory: the store's own
  // transaction, which undoes the appends of a failed effect.
  readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>;
}

export interface ReadOptions {
  readonly after?: Cursor.Cursor;
  readonly limit?: number;
}

export interface ReadPage {
  readonly events: ReadonlyArray<StoredEvent>;
  // Where the page stopped: the last event's, or `after` when it returned none.
  readonly cursor: Cursor.Cursor;
  readonly more: boolean;
}

// How the event store tells pollers that events were appended (ADR-0021).
export interface EventStoreConfig {
  // "coalesced" (default): appends do not notify; one notification per `wakeupWindowMs`, sent after the commit.
  // "off": nothing is ever sent; the pollers see new events only when their own interval (and idle backoff) comes round. Choose it to take the NOTIFY out of the database entirely
  // and accept the polling interval as the latency.
  readonly wakeupMode?: "coalesced" | "off";
  // The coalescing window (default 50). 0 sends after each commit without waiting.
  readonly wakeupWindowMs?: number;
  // The most events one append takes (default 50, DEFAULT_MAX_APPEND_EVENTS); more are refused with AppendTooLarge before any SQL runs. One append is
  // one transaction that holds the writer locks and sends one wake-up, so a larger batch holds every other writer back for longer (ADR-0049).
  readonly maxAppendEvents?: number;
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
  const tags: ReadonlyArray<Tag> = row.tags.map(TagCodec.decode);
  return {
    eventId: row.event_id,
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
// Whether this process's event store sends wake-ups (ADR-0021, ADR-0028): `makeEventStoreLayer` provides it, and the views, automations and outbox modules read it, so they
// LISTEN only when something will be sent. One setting, not one per module. (A `Reference` has a default, so code built without the layer behaves as "coalesced".)
export const Wakeups = Context.Reference<"coalesced" | "off">("crablet/Wakeups", { defaultValue: () => "coalesced" });

export const makeEventStoreLayer = (config: EventStoreConfig = {}) => Layer.merge(Layer.succeed(Wakeups, config.wakeupMode ?? "coalesced"), Layer.effect(
  EventStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const off = config.wakeupMode === "off";
    const windowMs = config.wakeupWindowMs ?? 50;
    const maxAppendEvents = maxAppendEventsOf(config.maxAppendEvents);
    if (!Number.isFinite(windowMs) || windowMs < 0) return yield* Effect.die(`wakeupWindowMs must be 0 or more, got ${windowMs}`);
    // The notification goes out on its own connection from the pool, never inside whatever transaction the caller happens to be in.
    const notifier = yield* makeWakeupNotifier(
      (payload) => Effect.updateContext(sql`SELECT pg_notify(${EVENTS_CHANNEL}, ${payload})`, Context.omit(sql.transactionService)),
      windowMs
    );

    const project = <T>(
      query: Query,
      after: LogPosition,
      projectors: ReadonlyArray<StateProjector<T>>
    ): Effect.Effect<ProjectionResult<T>, SqlError | EventDecodingError> =>
      Effect.gen(function* () {
        if (projectors.length === 0) {
          return yield* Effect.die("At least one projector is required");
        }
        // BEFORE the read: a snapshot taken earlier sees no more than the read's own (xmin never decreases, and a transaction it saw finished is still
        // finished), so the horizon is never above what the read could miss, and `seen` never treats as seen an event the read did not see (ADR-0048).
        const seen = yield* Sql.currentSnapshot(sql);
        const xmin = ReadSnapshot.parse(seen).xmin.toString();
        const rows = yield* Sql.queryEvents(sql, query, after);

        let state = projectors[0]!.initialState;
        let lastLogPosition = after;
        let latest = after;

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
          }
          latest = LogPositionNS.of(event.position, event.occurredAt, event.transactionId);
        }

        return { state: state as T, logPosition: lastLogPosition, horizon: { position: 0n, occurredAt: null, transactionId: xmin }, seen, latest };
      });

    // Asks the database for a yes or no (it stops at the first match) instead of reading every matching event.
    const exists = (query: Query): Effect.Effect<boolean, SqlError> => refusingEmptyItems(query, Sql.existsEvents(sql, query));

    // Instrumented once here, at the single write primitive.
    const appendWith = (
      appendedEvents: ReadonlyArray<AppendEvent>,
      condition: AppendCondition
    ): Effect.Effect<AppendResult, AppendTooLarge | Conflict | Duplicate | SqlError> => {
      if (appendedEvents.length === 0) {
        return Effect.die("Cannot append empty events list");
      }
      if (appendedEvents.length > maxAppendEvents) {
        return Effect.fail(new AppendTooLarge({ message: `Cannot append ${appendedEvents.length} events in one call; the limit is ${maxAppendEvents}. Split them into several appends.`, count: appendedEvents.length, max: maxAppendEvents }));
      }
      const refused = QueryNS.emptyItemIn(condition.concurrencyQuery) ?? QueryNS.emptyItemIn(condition.idempotencyQuery);
      if (refused !== null) return Effect.die(new Error(refused));
      const events = withDistinctTags(appendedEvents);
      const eventTypes = new Set(events.map((e) => e.type));
      const tagKeys = new Set(events.flatMap((e) => e.tags.map((t) => t.key)));
      return EventStoreMetrics.observe(
        EventStoreMetrics.append,
        Sql.appendEventsIf(sql, events, condition).pipe(
          // Remember what was appended for the wake-up. Inside `withWakeups` it waits for the commit; outside, it is sent now.
          Effect.tap(() =>
            off
              ? Effect.void
              : Effect.flatMap(Effect.service(PendingWakeups), (pending) => {
                  if (pending === null) return notifier.signal(eventTypes, tagKeys);
                  eventTypes.forEach((t) => pending.types.add(t));
                  tagKeys.forEach((k) => pending.tagKeys.add(k));
                  return Effect.void;
                })
          ),
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
      ).pipe(Effect.withSpan("crablet.eventstore.append", { attributes: { "crablet.append.events": events.length, "crablet.append.event_types": [...eventTypes].join(",") } }));
    };

    // With no condition (AppendCondition.empty(): empty concurrency and idempotency queries, which
    // append_events_if() skips without evaluating any check) nothing can be refused, so the narrower
    // `SqlError`-only type of the first overload is a runtime guarantee, not just a convenience.
    const append = ((events: ReadonlyArray<AppendEvent>, condition?: AppendCondition) =>
      appendWith(events, condition ?? AppendConditionNS.empty())) as EventStoreService["append"];

    // A span around a read, so a slow command can be told apart: how long its boundary took to load, against how long its append took.
    const tracedProject = (<T>(query: Query, after: LogPosition, projectors: ReadonlyArray<StateProjector<T>>) =>
      refusingEmptyItems(query, project(query, after, projectors)).pipe(Effect.withSpan("crablet.eventstore.project", { attributes: { "crablet.project.query_items": query.items.length } }))) as EventStoreService["project"];

    const withWakeups = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      off
        ? effect
        : Effect.suspend(() => {
            const pending: PendingWakeups = { types: new Set(), tagKeys: new Set() };
            return Effect.provideService(effect, PendingWakeups, pending).pipe(
              Effect.tap(() => (pending.types.size === 0 ? Effect.void : notifier.signal(pending.types, pending.tagKeys)))
            );
          });

    const read = (query: Query, options: ReadOptions = {}): Effect.Effect<ReadPage, SqlError> => {
      const limit = pageSizeOf(options.limit);
      if (typeof limit === "string") return Effect.die(new Error(limit));
      const after = options.after ?? Cursor.start;
      const { transactionId, position } = Cursor.parts(after);
      return refusingNoItems(
        query,
        Effect.map(Sql.queryPage(sql, query, { position, occurredAt: null, transactionId }, limit), (rows): ReadPage => {
          const events = rows.map(parseRow);
          const last = events[events.length - 1];
          return { events, cursor: last === undefined ? after : Cursor.of(last.transactionId, last.position), more: events.length === limit };
        })
      ).pipe(Effect.withSpan("crablet.eventstore.read", { attributes: { "crablet.read.limit": limit } }));
    };

    const service: EventStoreService = { append, project: tracedProject, exists, findDuplicate: (query) => refusingEmptyItems(query, Sql.findDuplicate(sql, query)), withWakeups, read,
      transaction: (effect) => withWakeups(sql.withTransaction(effect)) };

    return service;
  })
));

// The default: coalesced wake-ups, 50 ms window (ADR-0021).
export const EventStoreLive = makeEventStoreLayer();

// Every event `query` matches after `after`, page after page (`read`, `batchSize` a page), until a page is not full: what had finished when each page
// was read. It ends there; to follow the log as it grows, use a processor (ADR-0050).
export const stream = (query: Query, options: { readonly after?: Cursor.Cursor; readonly batchSize?: number } = {}): Stream.Stream<StoredEvent, SqlError, EventStore> =>
  Stream.unwrap(
    Effect.map(Effect.service(EventStore), (es) =>
      Stream.paginate(options.after ?? Cursor.start, (after) =>
        Effect.map(es.read(query, { after, ...(options.batchSize === undefined ? {} : { limit: options.batchSize }) }), (page) =>
          [page.events, page.more ? Option.some(page.cursor) : Option.none<Cursor.Cursor>()] as const
        )
      )
    )
  );

// The events `query` matches, every one visible now (settled or not), and the position to append after: the read a decision is made on (ADR-0050).
// Pass `position` to AppendCondition.failIfEventsMatch: the append is then refused only for a matching event this read could not see. No page size:
// for a decision's boundary (an entity, a few), not the whole log; to go through many events, use `read` or `stream`.
export const readToDecide = (
  query: Query
): Effect.Effect<{ readonly events: ReadonlyArray<StoredEvent>; readonly position: AppendConditionNS.DecisionPosition }, SqlError | EventDecodingError, EventStore> =>
  refusingNoItems(
    query,
    Effect.flatMap(Effect.service(EventStore), (es) =>
      Effect.map(
        es.project(query, LogPositionNS.zero(), [
          { eventTypes: [], initialState: [] as ReadonlyArray<StoredEvent>, transition: (events: ReadonlyArray<StoredEvent>, e: StoredEvent) => [...events, e] }
        ]),
        (r) => ({ events: r.state, position: AppendConditionNS.decisionPositionOf(r.logPosition, r.seen) })
      )
    )
  );
