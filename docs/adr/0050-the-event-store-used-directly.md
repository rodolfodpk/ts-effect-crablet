# ADR-0050: The event store, used directly

## Status

**Accepted** (2026-10-30). Built: `EventStoreService.read` and `transaction`; the functions `stream` and `readToDecide`; `Cursor`;
`AppendCondition.failIfEventsMatch` and `DecisionPosition`; `Query.all()` and `Query.union`. The guide is
[use the event store directly](../guides/build/use-the-event-store-directly.md). Completes what ADR-0049 left for later.

## Context

The event store's API had grown to serve the command framework. Used directly, it had gaps:

- The only read was `project(query, after, projectors)`, a fold: to get the events one wrote a projector that collects them and passed
  `LogPosition.zero()`. No page, no stream; everything into memory.
- A condition was `AppendCondition.of(afterPosition, query)`: one had to know which position to pass (a model's `logPosition`, or a horizon), and had
  no way to carry the read's snapshot, so a direct decision still conflicted on events its read saw while any transaction was open (the bug
  ADR-0048 fixed for commands; ADR-0048 kept the snapshot internal).
- "Every event" had no form of its own: a query with no items meant every event in a read and no check in a condition.
- A transaction with its wake-ups was `withWakeups(sql.withTransaction(...))`, in an order that is easy to get wrong.

The DCB specification asks for a `read(query, options?)` returning *"some form of iterable or reactive stream"* that *MAY* limit how many events
it loads, an `append(events, condition?)` with `{ failIfEventsMatch, after? }`, `after` being *"the highest position the client was aware of while
building the Decision Model"*, and a query that *"represent[s] a query that matches all Events"*.

## Decision

1. **Two reads, for two purposes.**
   - `read(query, { after, limit })` returns one page, in (transaction id, position) order, of events whose transaction had finished (the pollers'
     bound, ADR-0012), with the `Cursor` where it stopped and `more` when the page is full. Resuming from the cursor never skips an event, even one
     that commits late at a lower position. The price: an open transaction holds the page back, as it holds the processors.
   - `readToDecide(query)` returns every matching event visible now, settled or not, and the `DecisionPosition` to append after. It is the read a
     command's model makes, for a decision's boundary, not for the whole log.
2. **`after` comes from the read.** `DecisionPosition` is opaque: the read's cursor and its snapshot. `AppendCondition.failIfEventsMatch(query,
   { after, idempotency })` puts them in the condition, so only a matching event the read could not see is a conflict, the same exact check commands
   have. This revisits ADR-0048's choice to give the snapshot no public way in: it still has no constructor, it travels from a read to a condition.
   Without `after`, the condition refuses the append for any matching event, as the specification says. `AppendCondition.of` and `failIfChanged`
   stay for code that uses them.
3. **`Query.all()` is its own variant** (`{ items: [], all: true }`). In a read, every event; in a condition, any event after the position is a
   conflict (the SQL already matches an item with neither types nor tags with every event and locks it with the global key, so no migration).
   `Query.union` keeps it when queries are combined, and the command framework combines with it. The empty query keeps its old meanings in
   `project` and in conditions; the new reads refuse it, so they are not ambiguous. A lifecycle guard on every event is refused.
4. **Primitives on the service, the rest as functions.** `read` and `transaction` join the service, because each store does them its own way
   (SQL with a bound, the in-memory log; `sql.withTransaction`, the in-memory rollback). `stream` (pages of `read`) and `readToDecide` (`project`
   with a collecting projector) are functions over the `EventStore` in the context: one implementation, nothing more for a store to implement. The
   service has seven methods; `project`, `exists`, `findDuplicate` and `withWakeups` are documented as used by the command framework.
5. **`transaction(effect)`** is `withWakeups(sql.withTransaction(effect))`: one transaction, its wake-ups after the commit, nothing on a failure.
6. **No retry helper.** A direct decision retries a `Conflict` with `Effect.retry`; reading, deciding, retrying, recognising a repeat and auditing
   together is what a command is.

7. **Where the framework uses them.** The command framework, the pollers and the views keep their own paths: a model folds without keeping
   the events (`project`), a command's condition combines several reads, and a poller selects by tag key alone, keeps its cursor in a progress
   table and commits a batch with its cursor. Two places walk many events and use `stream`:
   - `verifyEvents({ all: true })`, which paged by position and so could skip an event that committed late; it now walks each type with
     `stream`, and a window (`fromPosition`, `toPosition`) is a filter over it;
   - the **event log API** (`eventsGroup` in `@crablet/processors-http`, `GET /admin/events`), behind the processors' authorization: a page of
     `read` for types and tags, with the `cursor` to read on from. A payload is shown only through the application's mask,
     `eventPayloadMask(definitions)` (`@crablet/commands/Personal`): the fields marked `personal(...)` redacted and the keys a definition does not
     know dropped; a type with no definition, or no mask at all, shows no payload. The admin page (`tools/processors-admin-ui`) has an Events tab
     over it. This is the "event log API" `personal(...)` was documented as masking for.

## Consequences

- Direct use has the specification's model, read, decide, append after, with the conflict commands have.
- `stream` ends when it has caught up with the finished events; following the log as it grows is a processor's job.
- Breaks (`scripts/breaks.ts`): `page-unsettled`, `decision-position-without-snapshot`, `query-all-dropped`, `union-drops-all`, `event-log-unmasked`.
- Tests: the conformance suite (pages, the stream, `Query.all()`, `readToDecide` with `failIfEventsMatch`) on Postgres and in memory; a page
  under a transaction-id inversion (`read-page.test.ts`); a direct decision under an open transaction (`decide-direct.test.ts`); a command whose
  lookup reads every event (`query-all-postgres.test.ts`); `transaction` and its wake-ups (`wakeups.test.ts`); the guide's code, with a race
  (`direct-use.test.ts`).
