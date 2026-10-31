# ADR-0052: Short forms for direct use

## Status

**Accepted** (2026-10-30). Built: `Query.match`, `AppendEvent.make`, `Decision.append` (what `readToDecide` returns), the functions `append`, `read`
and `transaction`, and `@crablet/eventstore/Postgres` with `layer`. Builds on [ADR-0050](0050-the-event-store-used-directly.md).

## Context

ADR-0050 gave direct use the specification's model: read to decide, then append after the read. Its code was correct and long. One decision in the
guide built a query in three calls (`Query.of(Query.queryItemOf(types, [{ key, value }]))`), an event with a builder, named its query twice (in the
read and in the condition), took the service from the context only to call `append`, and assembled the Postgres layer by hand
(`Layer.provideMerge(EventStoreLive, PgClient.layer(...))`).

## Decision

Five additions. Nothing is changed or removed (ADR-0013); the longer forms stay for what the short ones do not cover.

1. **`Query.match(types, tags?)`**: one item, its types as a string or a list, its tags as an object (`{ copy_id: id }`, a number value as text). A
   tag whose value is `null` or `undefined` is **refused**: leaving it out would widen what the query selects, and a decision would read other
   entities' events. Several items stay `Query.union`; one key with several values stays `queryItemOf`.
2. **`AppendEvent.make(type, data, tags?)`**: the builder's event, its tags as an object. A tag whose value is `null` or `undefined` is **not added**,
   as in the builder: an optional field gives a tag only when it is there. The asymmetry with `match` is deliberate: a missing tag narrows what an
   event is found by, which is the author's choice; on a query it widens what a decision depends on, silently. `of` already names the one-tag form
   `(type, tagKey, tagValue, data)`; an overload would be ambiguous with string data, so the new form is `make`.
3. **`readToDecide` returns a `Decision`** with `append(events, { idempotency?, firstWrite? })`, which appends under
   `failIfEventsMatch(the read's query, { after: the read's position, idempotency })`. `events` and `position` stay. It appends through the
   `EventStore` in the context when it runs, as the functions below do, so a decision holds no store of its own (one captured from the read would
   outlive the layer that built it). A condition other than the read's query stays `failIfEventsMatch` with `append`.
4. **`append`, `read` and `transaction` as functions** over the `EventStore` in the context, beside `stream` and `readToDecide`. The service keeps
   its seven methods (ADR-0050); the framework's (`project`, `exists`, `findDuplicate`, `withWakeups`) get no function.
5. **`@crablet/eventstore/Postgres`**, with `layer(pg, config?)`: `makeEventStoreLayer(config)` over `PgClient.layer(pg)`, the clients kept in the
   output, the same connection shape as `Crablet.layer`. An entry point of its own, so `@crablet/eventstore` itself still uses only the generic
   `SqlClient` and names no driver. The package already depends on `@effect/sql-pg` (`Listen`, `Leader`, `SessionClients`).

## Consequences

- The guide's code and the package README show only the short forms; the guide lists the longer ones and when they are needed.
- Two ways to write the same query or event exist; the documentation leads with one.
- No retry helper still (ADR-0050): `Effect.retry` on `Conflict` is the one repeated line left in a direct decision.
- Tests: `Query.match` and `AppendEvent.make` (unit); `decision.append` in the conformance suite on Postgres and in memory (an event the read saw,
  one it did not, a repeat); `firstWrite` passed on, on Postgres; the guide's code, through `Postgres.layer`. Break: `decision-append-without-position`.
