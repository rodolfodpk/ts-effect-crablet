# ADR-0051: Client metadata, and correlation and causation for direct use

## Status

**Accepted** (2026-10-30). Built: the column `crablet_events.metadata` (`V7__crablet_event_metadata.sql`); `AppendEvent.metadata` and
`StoredEvent.metadata`; `@crablet/eventstore/AppendContext` with `withCorrelationId`, `causedBy` and `withMetadata`; the event log API's
`metadataMask`.

## Context

The DCB specification lets an event carry *"further fields, like metadata defined by the client"*. The store recorded only its own: a
`correlation_id` (a uuid that groups what one request led to) and a `causation_id` (the position of the event that caused it). Both are set from an
Effect context the framework fills (an automation runs its command caused by its trigger, a deadline fires caused by its `DeadlineScheduled`, the
command API takes a correlation from the request), and that context was internal: code that appends directly could set neither.

The causation is not only informative. With a request fingerprint, it makes the emit key that stops one trigger appending one request twice
(ADR-0035), and it names a position in the log.

## Decision

1. **The store keeps recording correlation and causation itself**, from the context, and the framework keeps filling it where it knows them.
2. **Direct use can set them, safely.** `@crablet/eventstore/AppendContext`:
   - `withCorrelationId(uuid)(effect)`: every event appended inside carries it. A correlation has no invariant behind it, so any uuid will do; one
     that is not a uuid is refused.
   - `causedBy(event)(effect)`: the appends inside are caused by a *stored* event, its position, and carry its correlation. There is no way to give
     a causation as a bare number, so a causation always names a real event, and the emit key stays what ADR-0035 says.
3. **Client metadata is a column of its own**, `metadata JSONB`, apart from the payload (the domain's data) and from what the store records. An event
   carries it as `AppendEvent.metadata` (the builder's `.metadata(...)`), `withMetadata(object)(effect)` adds keys to every event appended inside
   (the event's own keys win), and a read returns it as `StoredEvent.metadata`, absent when there is none. It must be a JSON object, or the append is
   a defect. The framework records it and reads nothing in it; it is not queried by: what to select by goes in a tag.
4. **Metadata is withheld from the event log unless the application says otherwise.** It has no schema to mark personal data with (`personal(...)`
   marks a payload's fields), and metadata is where an actor's id or an address tends to go. The event log API shows it only through a
   `metadataMask` the application gives; without one, an event's metadata is withheld and the API says so.
5. **The append takes it as one more array**, parallel to the types, tags and payloads, with a default. `append_events_batch` and `append_events_if`
   are dropped and created again in V7 (a new parameter is a new signature), with their last bodies and the metadata added.

## Consequences

- The DCB guide's compatibility table has client metadata as compatible.
- The append is now in three files: the lock helpers in V2, `crablet_items_match_any` in V6, `append_events_if` and `append_events_batch` in V7.
  The breaks of each function edit the file that holds its last definition.
- Metadata adds to every event's row when it is given; nothing is stored when it is not.
- Tests: the conformance suite (an event's own metadata, the context's, both, none, and a value that is not an object; correlation and causation
  set around an append) on Postgres and in memory; the event log API withholds metadata without a mask; the guide's code. Break:
  `metadata-not-stored`.
