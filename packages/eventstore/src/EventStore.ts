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
import * as Sql from "./internal/sql.ts";

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
      return Sql.appendEventsIf(sql, events, condition);
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
