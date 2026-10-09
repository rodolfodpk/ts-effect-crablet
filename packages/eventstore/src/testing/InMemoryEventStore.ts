import { EventDecodingFailure, decodingErrorOf } from "../EventDecoding.ts";
import { Effect, Exit, Layer, Semaphore } from "effect";
import { EventStore, existsProjector, type EventStoreService, type StoredEvent } from "../EventStore.ts";
import type { AppendEvent } from "../AppendEvent.ts";
import type { AppendResult } from "../AppendResult.ts";
import type { AppendCondition } from "../AppendCondition.ts";
import { AppendTooLarge, Conflict, Duplicate, MAX_APPEND_EVENTS } from "../AppendErrors.ts";
import * as CorrelationContext from "../CorrelationContext.ts";
import * as LogPositionNS from "../LogPosition.ts";
import { checkAppend, queryMatches } from "../spec/Spec.ts";

// An in-memory EventStoreService for tests that must run without Postgres: unit tests of models,
// command decision logic, and BDD-style scenarios (see @crablet/commands/testing/Scenario).
//
// It implements the same specification as the Postgres store (spec/Spec.ts), INCLUDING enforcement of
// append conditions - `Conflict` and `Duplicate` are reported exactly when Postgres would, with the
// same messages - and the conformance suite proves the two agree. What it does not model:
//
//  - Concurrency. Nothing interleaves: every `append` is atomic, and `transaction` runs one command at a
//    time, so races (and therefore conflict retries) cannot occur. Anything about concurrent behaviour
//    must be tested against Postgres.
//  - Postgres-specific behaviour: LISTEN/NOTIFY, leader election, transaction ids/visibility, JSONB
//    normalisation (event data is round-tripped through JSON, which covers the common case).

export interface InMemoryEventStore {
  readonly service: EventStoreService;
  readonly layer: Layer.Layer<EventStore>;
  // Every stored event, in position order. A live view: it reflects later appends and rollbacks.
  readonly log: ReadonlyArray<StoredEvent>;
  // Every ACCEPTED `append` call, in order, with the condition it was given (if any).
  readonly appended: ReadonlyArray<{ readonly events: ReadonlyArray<AppendEvent>; readonly condition: AppendCondition | null }>;
  // Store events directly, as test setup: no condition, not recorded in `appended`.
  readonly seed: (...events: ReadonlyArray<AppendEvent>) => void;
  // Run `effect` exclusively (one at a time) and all-or-nothing: if it fails, dies or is interrupted,
  // everything it appended is rolled back - like a database transaction.
  readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export const makeInMemoryEventStore = (): InMemoryEventStore => {
  const log: Array<StoredEvent> = [];
  const appended: Array<{ events: ReadonlyArray<AppendEvent>; condition: AppendCondition | null }> = [];
  let transactionCounter = 0;
  const lock = Semaphore.makeUnsafe(1);

  const store = (events: ReadonlyArray<AppendEvent>, correlationId: string | null, causationId: bigint | null): AppendResult => {
    const transactionId = String(++transactionCounter);
    for (const e of events) {
      log.push({
        type: e.type,
        tags: e.tags,
        // round-trip through JSON like the real store, so data is plain JSON
        data: JSON.parse(JSON.stringify(e.eventData)),
        transactionId,
        position: BigInt(log.length + 1),
        occurredAt: new Date(),
        correlationId,
        causationId
      });
    }
    return { transactionId, lastPosition: BigInt(log.length) };
  };

  const append = ((events: ReadonlyArray<AppendEvent>, condition?: AppendCondition) =>
    Effect.gen(function* () {
      if (events.length === 0) return yield* Effect.die("Cannot append empty events list");
      if (events.length > MAX_APPEND_EVENTS) {
        return yield* new AppendTooLarge({ message: `Cannot append ${events.length} events in one call; the limit is ${MAX_APPEND_EVENTS}. Split them into several appends.`, count: events.length, max: MAX_APPEND_EVENTS });
      }
      const verdict = condition ? checkAppend(log, condition) : "ok";
      if (verdict === "duplicate") {
        return yield* new Duplicate({ message: "Duplicate operation: duplicate operation detected" });
      }
      if (verdict === "conflict") {
        return yield* new Conflict({ message: "AppendCondition violated: append condition violated", kind: "boundary" });
      }
      const correlationId = yield* CorrelationContext.correlationId;
      const causationId = yield* CorrelationContext.causationId;
      // Nothing above suspends, so the check and the insert are one atomic step.
      appended.push({ events, condition: condition ?? null });
      return store(events, correlationId, causationId);
    })) as EventStoreService["append"];

  const project: EventStoreService["project"] = (query, after, projectors) =>
    Effect.gen(function* () {
      if (projectors.length === 0) return yield* Effect.die("At least one projector is required");
      let state = projectors[0]!.initialState;
      let last = after;
      // serial and atomic: a read sees the whole log as it is, so its horizon is the end of the log
      const head = log[log.length - 1];
      const horizon = head ? LogPositionNS.of(head.position, head.occurredAt, head.transactionId) : after;
      for (const event of log) {
        if (event.position <= after.position || !queryMatches(query, event)) continue;
        for (const projector of projectors) {
          if (projector.eventTypes.length === 0 || projector.eventTypes.includes(event.type)) {
            try {
              state = projector.transition(state, event);
            } catch (error) {
              if (!(error instanceof EventDecodingFailure)) throw error;
              return yield* decodingErrorOf(error, event);
            }
          }
        }
        last = LogPositionNS.of(event.position, event.occurredAt, event.transactionId);
      }
      return { state: state as never, logPosition: last, horizon };
    });

  const service: EventStoreService = {
    append,
    project,
    exists: (query) => Effect.map(Effect.catchTag(project(query, LogPositionNS.zero(), [existsProjector()]), "EventDecodingError", (e) => Effect.die(e)), (r) => r.state),
    withWakeups: (effect) => effect // nothing to wake in memory
  };

  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    lock.withPermits(1)(
      Effect.suspend(() => {
        const logMark = log.length;
        const appendedMark = appended.length;
        return Effect.onExit(effect, (exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.sync(() => {
                log.length = logMark;
                appended.length = appendedMark;
              })
        );
      })
    );

  return {
    service,
    layer: Layer.succeed(EventStore, service),
    log,
    appended,
    seed: (...events) => void store(events, null, null),
    transaction
  };
};
