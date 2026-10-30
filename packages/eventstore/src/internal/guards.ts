import { Effect } from "effect";
import type { AppendEvent } from "../AppendEvent.ts";
import * as Query from "../Query.ts";
import * as Tag from "../Tag.ts";

// What both stores check and do at their boundary, the same way (ADR-0049).

// A query with an item that has neither types nor tags is refused, as a defect: it matches nothing the DCB specification defines.
export const refusingEmptyItems = <A, E, R>(query: Query.Query, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const refused = Query.emptyItemIn(query);
  return refused === null ? effect : Effect.die(new Error(refused));
};

// Each event with its tags once each: a repeated tag (same key, same value) is written once (the specification: tags SHOULD not repeat).
export const withDistinctTags = (events: ReadonlyArray<AppendEvent>): ReadonlyArray<AppendEvent> =>
  events.map((e) => {
    const tags = Tag.distinct(e.tags);
    // Stryker disable next-line ConditionalExpression: copying an event whose tags did not change gives an equal event.
    return tags.length === e.tags.length ? e : { ...e, tags };
  });
