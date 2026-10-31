# Use the event store directly

*Guide · developers · [consistency boundaries](../../concepts/dcb-guide.md) read · 15 minutes*

Most code writes through **commands** ([test a command](test-a-command.md), [expose one over HTTP](expose-a-command-over-http.md)): you declare a
model and a decision, and the framework reads, decides, appends under the right condition, retries a conflict, recognises a repeat and records an
audit. This guide is for the other cases: a script, an import, an export, a tool, or a decision that does not fit a command. You use the
[`@crablet/eventstore`](../../../packages/eventstore/README.md) API, which follows the [DCB specification](https://dcb.events/specification/):
read events, decide, and append with a condition ([how close it is](../../concepts/dcb-guide.md#compatibility-with-the-specification)).

Prefer a command when you would otherwise write its parts yourself: retries, idempotency, an audit, an HTTP endpoint, an automation that issues it.

## Set it up

What this guide uses, and the entry point each comes from:

<!-- file: packages/eventstore/test/support/direct-use.ts#imports -->
```ts
import { Data, Effect, Layer, Schedule, Stream } from "effect";
import { append, EventStore, read, readToDecide, stream, transaction } from "@crablet/eventstore";
import * as AppendContext from "@crablet/eventstore/AppendContext";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { Conflict } from "@crablet/eventstore/AppendErrors";
import * as Postgres from "@crablet/eventstore/Postgres";
import * as Query from "@crablet/eventstore/Query";
import { makeInMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
```

The code below needs an `EventStore`, which a layer provides: on Postgres, `EventStoreLive` over a connection pool; in a test, the in-memory
store. The database must have the migrations of [`@crablet/db-migrations`](../../../packages/db-migrations/README.md) applied, by your own tool
([run it in production](../operate/run-in-production.md)); nothing applies them for you. `Cursor` (`@crablet/eventstore/Cursor`) is needed only to keep
a cursor as text.

<!-- file: packages/eventstore/test/support/direct-use.ts#setup -->
```ts
// A program that uses the store needs `EventStore`; a layer provides it:
//   on Postgres, `Postgres.layer({ host, port, database, username, password })`, on a database the migrations of @crablet/db-migrations were
//   applied to; in a test, `makeInMemoryEventStore().layer`, which passes the same conformance suite.
export const runWith = <LE>(layer: Layer.Layer<EventStore, LE>) => <A, E>(program: Effect.Effect<A, E, EventStore>) =>
  Effect.runPromise(Effect.provide(program, layer));
```

`runWith(onPostgres({ host, port, database, username, password: Redacted.make(secret) }))(lendCopy("c-1", "m-7"))` runs the first example below
(`Redacted` is from `effect`). The in-memory store has no database underneath: its `transaction` only rolls back, and where it behaves
differently, this guide says so.

## Read, decide, append

A decision reads the events it depends on with `readToDecide`, decides, and appends with `AppendCondition.failIfEventsMatch(query, { after })`.
The append is refused with `Conflict` if an event matching the query was appended after the read. `after` is the position the read returns: it holds
what the read could see, so an event the read saw is never a conflict, however recent ([ADR-0048](../../adr/0048-a-conflict-is-what-the-read-did-not-see.md)).
A refused decision is decided again by reading again; here up to three times, with `Effect.retry`.

<!-- file: packages/eventstore/test/support/direct-use.ts#decide -->
```ts
// What a lend depends on: the copy's loans and returns.
const copyEvents = (copyId: string) => Query.match(["CopyLent", "CopyReturned"], { copy_id: copyId });

export const lendCopy = (copyId: string, memberId: string) =>
  Effect.gen(function* () {
    // 1. Read what the decision depends on.
    const decision = yield* readToDecide(copyEvents(copyId));
    // 2. Decide.
    const lent = decision.events.filter((e) => e.type === "CopyLent").length > decision.events.filter((e) => e.type === "CopyReturned").length;
    if (lent) return yield* new CopyNotAvailable({ copyId });
    // 3. Append, refused if anything the decision depends on was appended after the read.
    return yield* decision.append([AppendEvent.make("CopyLent", { copyId, memberId }, { copy_id: copyId, member_id: memberId })]);
  }).pipe(
    // A refused append means the decision was made on a state that has changed: read and decide again, a few times.
    Effect.retry({ while: (error) => error instanceof Conflict, schedule: Schedule.recurs(3) })
  );
```

Without `after`, the condition refuses the append if *any* matching event exists (a "this must be the first" rule). With `idempotency`, it also
refuses with `Duplicate` when an event matching that query already exists, checked first. `readToDecide` reads every matching event into memory,
which is right for what a decision depends on (an entity, a few) and wrong for the whole log: for that, read in pages.

## Read in pages, or as a stream

`read(query, { after, limit })` returns one page: the events in log order, the `cursor` where it stopped, and `more` when the page was full.
Resume from the cursor until `more` is false. `stream(query)` asks for the pages itself. A cursor can be kept as text (`Cursor.toString`,
`Cursor.fromString`) to resume later, an export interrupted for instance.

<!-- file: packages/eventstore/test/support/direct-use.ts#read -->
```ts
// Every loan of a member, page by page: resume from `cursor` until `more` is false.
export const loansOf = (memberId: string) =>
  Effect.gen(function* () {
    const query = Query.match("CopyLent", { member_id: memberId });
    let page = yield* read(query, { limit: 100 });
    const loans = [...page.events];
    while (page.more) {
      page = yield* read(query, { after: page.cursor, limit: 100 });
      loans.push(...page.events);
    }
    return loans;
  });

// The same as a stream, which asks for the pages itself.
export const loanCount = (memberId: string) => Stream.runCount(stream(Query.match("CopyLent", { member_id: memberId }), { batchSize: 100 }));
```

A page holds only events whose transaction had finished, so resuming from its cursor never skips one, even one that commits late. The other side: while
a transaction that has written stays open anywhere in the database, a page stops before the events of every transaction that first wrote after it
did, and `more: false` means "no more finished events now", not "no more events". A transaction that has only read holds nothing back. Your own
transaction counts too: inside `transaction`, once it has appended, a page shows neither its own events nor any newer one; read with `readToDecide`
there, which sees them. (In memory every event has finished, so a page shows them all.) A stream ends when it has caught up; to follow the log
as it grows, [add a view](add-a-view.md) or an
[automation](add-an-automation.md), which are woken by new events.

To read every event, use `Query.all()`; a query with no items is refused by these reads. In a condition, `Query.all()` refuses the append for any
event at all after the position, and it waits for every other writer: keep it for a rule that really is about the whole log.

## Several appends together

`transaction(effect)` runs the effect in one database transaction and wakes the processors once it has committed; if the effect fails, nothing it
appended is stored and nothing is announced.

<!-- file: packages/eventstore/test/support/direct-use.ts#transaction -->
```ts
// Two appends that stand or fall together: one transaction, and the processors are woken once it has committed.
export const lendTwo = (first: string, second: string, memberId: string) => transaction(Effect.andThen(lendCopy(first, memberId), lendCopy(second, memberId)));
```

On Postgres, within one transaction an append is not refused for events that same transaction appended earlier: a decision that depends on what you
just wrote should read again after writing, as `lendTwo` does (each `lendCopy` reads first). To refuse an append that is not its transaction's first
write, as commands do, use `AppendCondition.firstWrite(condition)` ([note 3 of the compatibility table](../../concepts/dcb-guide.md#compatibility-with-the-specification)).
The in-memory store has neither the exception nor `firstWrite`: there an append is refused for an event its own transaction appended after the read, and `firstWrite` changes nothing.

## What the store records besides the events

An event can record a correlation id (what groups everything one request led to), a causation (the position of the event that caused it) and
metadata: a JSON object of your own, stored apart from the payload. Each is recorded only when something sets it; an event appended directly with
nothing around it has none ([ADR-0051](../../adr/0051-client-metadata-correlation-and-causation.md)).
Set them around the appends with `@crablet/eventstore/AppendContext`:

<!-- file: packages/eventstore/test/support/direct-use.ts#context -->
```ts
// A lend asked for at the front desk: its events carry the request's correlation id (a uuid, from the caller's header, say) and metadata saying
// where it came from. The framework records both; it reads neither.
export const lendAtTheDesk = (copyId: string, memberId: string, requestId: string) =>
  lendCopy(copyId, memberId).pipe(AppendContext.withCorrelationId(requestId), AppendContext.withMetadata({ source: "front-desk" }));
```

`withCorrelationId` takes a uuid: anything else throws when it is called, before the effect runs. `causedBy(event)` makes the appends inside
caused by a stored event, and carries its correlation: only an event can be a cause, so a causation always names a real position. Commands,
automations and deadlines set the correlation and the causation themselves; `withMetadata` and `withCorrelationId` around a command's `run` work
the same way. Metadata is recorded and never read by the framework: what you select by goes in a
tag, and personal data does not go in metadata, which the event log shows only through a mask of its own.

## Limits

- One append takes at most `maxAppendEvents` events, 50 unless configured ([keep an append small](../operate/run-in-production.md#keep-an-append-small)).
- A query item targets events by type and/or tags; one with neither is refused.
- A tag's key and value may hold any characters, and a tag repeated on an event is stored once.
- `.tag(key, value)` with a `null` or `undefined` value adds no tag, and says nothing: an optional field gives a tag only when it is there.

The code of this guide is [`direct-use.ts`](../../../packages/eventstore/test/support/direct-use.ts), run in memory and on Postgres, with two lends of
one copy raced ([ADR-0050](../../adr/0050-the-event-store-used-directly.md)).
