import type { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";

// The command a deadline fires is caused by the deadline's event, and carries its correlation id. A copy of the primer views and automations each keep: modules
// share no code with each other (decision V4, 2026-11-23), so that changing one module never touches another.
export const withEventContext = <A, E, R>(event: StoredEvent, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const withCausation = CorrelationContext.withCausationId(event.position)(effect);
  return event.correlationId !== null ? CorrelationContext.withCorrelationId(event.correlationId)(withCausation) : withCausation;
};
