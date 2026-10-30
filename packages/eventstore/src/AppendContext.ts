import type { Effect } from "effect";
import * as CorrelationContext from "./CorrelationContext.ts";
import type { StoredEvent } from "./EventStore.ts";

// What the store records about an append besides its events, set around the appends of an effect (ADR-0051). The framework sets the correlation
// and the causation itself where it knows them (an automation runs its command caused by its trigger; a deadline fires caused by its
// `DeadlineScheduled`); these are for code that appends directly, or that calls a command, and knows more.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every event appended within `effect` carries this correlation id: what groups everything one request led to (a header from the caller, say).
// A uuid, or a defect.
export const withCorrelationId = (correlationId: string) => {
  if (!UUID.test(correlationId)) throw new Error(`a correlation id is a uuid, got ${JSON.stringify(correlationId)}`);
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => CorrelationContext.withCorrelationId(correlationId)(effect);
};

// Every event appended within `effect` was caused by `event`: its causation is that event's position, and it carries the same correlation when the
// event has one. Only a stored event can be a cause, so the causation always names a real position in the log.
export const causedBy = (event: Pick<StoredEvent, "position" | "correlationId">) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const caused = CorrelationContext.withCausationId(event.position)(effect);
    return event.correlationId === null ? caused : CorrelationContext.withCorrelationId(event.correlationId)(caused);
  };

// Every event appended within `effect` carries this metadata (a JSON object), added to its own (the event's keys, then an inner withMetadata, win).
// Recorded, never read by the framework, not queried by: what to select by goes in a tag; personal data does not go here unless the event log is given
// a mask for it (ADR-0051).
export const withMetadata = (metadata: Readonly<Record<string, unknown>>) => CorrelationContext.withMetadata(metadata);
