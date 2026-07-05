import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import type { StoredEvent } from "@crablet/eventstore";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";

// Port of com.crablet.views.ViewProjector. Java's handle(String viewName, List<StoredEvent> events)
// takes a redundant viewName parameter, since exactly one bean serves one view - dropped here since
// viewName is already a property of the projector itself. R is fixed to never: by the time a
// ViewProjector is handed to ViewsModule.makeViewsProcessor, every ambient service it needs must
// already be resolved (see makeTransactionalViewProjector below for the standard way to do that).
export interface ViewProjector<E = unknown> {
  readonly viewName: string;
  readonly handle: (events: ReadonlyArray<StoredEvent>) => Effect.Effect<number, E, never>;
}

const withEventContext = <A, E, R>(event: StoredEvent, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const withCausation = CorrelationContext.withCausationId(event.position)(effect);
  return event.correlationId !== null
    ? CorrelationContext.withCorrelationId(event.correlationId)(withCausation)
    : withCausation;
};

// Port of AbstractViewProjector.java: wraps the whole batch in one transaction (any per-event
// failure rolls back everything handled so far in this batch, matching Java's
// TransactionTemplate(PROPAGATION_REQUIRED) behavior) and propagates each event's
// causation/correlation ids via CorrelationContext (Java: ScopedValue) before calling handleEvent.
//
// `sql` is passed explicitly into `handleEvent` (mirroring Java's `handleEvent(event, jdbc)`)
// rather than expected to be re-resolved ambiently inside it - `handleEvent` calling
// `sql.unsafe(...)`/tagged-template queries with this same `sql` value, from within the effect
// `sql.withTransaction` is currently running, is what makes those writes participate in the
// transaction (see EventStore.ts's primer on `SqlClient.withTransaction`'s ambient behavior).
export const makeTransactionalViewProjector = <E>(
  viewName: string,
  handleEvent: (event: StoredEvent, sql: SqlClient.SqlClient) => Effect.Effect<void, E, never>
): Effect.Effect<ViewProjector<E | SqlError>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const handle = (events: ReadonlyArray<StoredEvent>): Effect.Effect<number, E | SqlError, never> =>
      sql.withTransaction(
        Effect.gen(function* () {
          for (const event of events) {
            yield* withEventContext(event, handleEvent(event, sql));
          }
          return events.length;
        })
      );

    return { viewName, handle };
  });
