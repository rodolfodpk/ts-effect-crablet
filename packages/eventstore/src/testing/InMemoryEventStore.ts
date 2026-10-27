import { EventDecodingFailure, decodingErrorOf } from "../EventDecoding.ts";
import { Clock, Effect, Exit, Layer, Semaphore } from "effect";
import { EventStore, type EventStoreService, type StoredEvent } from "../EventStore.ts";
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
  // The request fingerprint each event was appended with (ADR-0034), by position: not part of StoredEvent, as in Postgres.
  const fingerprints = new Map<bigint, string | null>();
  // The appends made under a cause, by `<cause>/<fingerprint>` (ADR-0035): the database's unique emit key, in memory. A request appends the same
  // events again, so a repeat always collides with an earlier append as a whole. The value is that append's last event, which the repeat is
  // reported with, as in Postgres.
  const emitKeys = new Map<string, bigint>();
  const appended: Array<{ events: ReadonlyArray<AppendEvent>; condition: AppendCondition | null }> = [];
  let transactionCounter = 0;
  const lock = Semaphore.makeUnsafe(1);

  // `occurredAt` is the append's instant from the Effect Clock, as in Postgres (a test clock fixes both); `seed`, which runs outside any effect, takes
  // the system's.
  const store = (
    events: ReadonlyArray<AppendEvent>,
    correlationId: string | null,
    causationId: bigint | null,
    fingerprint: string | null = null,
    occurredAt: Date = new Date()
  ): AppendResult => {
    const transactionId = String(++transactionCounter);
    for (const e of events) {
      fingerprints.set(BigInt(log.length + 1), fingerprint);
      log.push({
        eventId: crypto.randomUUID(),
        type: e.type,
        tags: e.tags,
        // round-trip through JSON like the real store, so data is plain JSON
        data: JSON.parse(JSON.stringify(e.eventData)),
        transactionId,
        position: BigInt(log.length + 1),
        occurredAt,
        correlationId,
        causationId
      });
    }
    // Stryker disable next-line ConditionalExpression,LogicalOperator: `append` looks a key up only with both set, so a key stored without them is never read.
    if (causationId !== null && fingerprint !== null) emitKeys.set(`${causationId}/${fingerprint}`, BigInt(log.length));
    return { transactionId, lastPosition: BigInt(log.length) };
  };

  // What `query` matches, as Postgres reports it (crablet_items_duplicate): the latest match and the distinct requests behind the matches.
  const duplicateOf = (query: AppendCondition["idempotencyQuery"]): Duplicate | null => {
    const matched = log.filter((event) => queryMatches(query, event));
    const latest = matched[matched.length - 1];
    if (latest === undefined) return null;
    const requests = new Map<string, { fingerprint: string | null; causationId: bigint | null }>();
    for (const event of matched) {
      const fingerprint = fingerprints.get(event.position) ?? null;
      requests.set(`${fingerprint}/${event.causationId}`, { fingerprint, causationId: event.causationId });
    }
    return new Duplicate({
      message: "Duplicate operation: duplicate operation detected",
      latest: { position: latest.position, transactionId: latest.transactionId },
      requests: [...requests.values()],
      byTrigger: false
    });
  };

  const append = ((events: ReadonlyArray<AppendEvent>, condition?: AppendCondition) =>
    Effect.gen(function* () {
      if (events.length === 0) return yield* Effect.die("Cannot append empty events list");
      if (events.length > MAX_APPEND_EVENTS) {
        return yield* new AppendTooLarge({ message: `Cannot append ${events.length} events in one call; the limit is ${MAX_APPEND_EVENTS}. Split them into several appends.`, count: events.length, max: MAX_APPEND_EVENTS });
      }
      const verdict = condition ? checkAppend(log, condition) : "ok";
      if (verdict === "duplicate") {
        return yield* duplicateOf(condition!.idempotencyQuery)!;
      }
      if (verdict === "conflict") {
        return yield* new Conflict({ message: "AppendCondition violated: append condition violated", kind: "boundary" });
      }
      const correlationId = yield* CorrelationContext.correlationId;
      const causationId = yield* CorrelationContext.causationId;
      const fingerprint = yield* CorrelationContext.requestFingerprint;
      const occurredAt = new Date(yield* Clock.currentTimeMillis);
      // The same trigger appending the same request again: refused like Postgres's unique emit key (ADR-0035).
      const repeated = causationId !== null && fingerprint !== null ? emitKeys.get(`${causationId}/${fingerprint}`) : undefined;
      if (repeated !== undefined) {
        const earlier = log[Number(repeated) - 1]!;
        return yield* new Duplicate({
          message: "Duplicate operation: this trigger already appended this request",
          latest: { position: earlier.position, transactionId: earlier.transactionId },
          requests: [{ fingerprint, causationId }],
          byTrigger: true
        });
      }
      // Nothing above suspends, so the check and the insert are one atomic step.
      appended.push({ events, condition: condition ?? null });
      return store(events, correlationId, causationId, fingerprint, occurredAt);
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
      // Every event is settled in memory, so the newest one read is also the last settled one.
      return { state: state as never, logPosition: last, horizon, latest: last };
    });

  const service: EventStoreService = {
    append,
    project,
    exists: (query) => Effect.sync(() => log.some((event) => queryMatches(query, event))),
    findDuplicate: (query) => Effect.sync(() => duplicateOf(query)),
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
                // `fingerprints` needs nothing: the next event stored at a position replaces its entry before anything reads it.
                for (const [key, position] of emitKeys) if (position > BigInt(logMark)) emitKeys.delete(key);
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
