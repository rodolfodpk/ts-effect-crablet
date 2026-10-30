# Use the event store directly

*Guide · developers · [consistency boundaries](../../concepts/dcb-guide.md) read · 15 minutes*

Most code writes through **commands** ([test a command](test-a-command.md), [expose one over HTTP](expose-a-command-over-http.md)): you declare a
model and a decision, and the framework reads, decides, appends under the right condition, retries a conflict, recognises a repeat and records an
audit. This guide is for the other cases: a script, an import, an export, a tool, or a decision that does not fit a command. You use the
[`@crablet/eventstore`](../../../packages/eventstore/README.md) API, which follows the [DCB specification](https://dcb.events/specification/):
read events, decide, and append with a condition ([how close it is](../../concepts/dcb-guide.md#compatibility-with-the-specification)).

Prefer a command when you would otherwise write its parts yourself: retries, idempotency, an audit, an HTTP endpoint, an automation that issues it.

## Read, decide, append

A decision reads the events it depends on with `readToDecide`, decides, and appends with `AppendCondition.failIfEventsMatch(query, { after })`.
The append is refused with `Conflict` if an event matching the query was appended after the read. `after` is the position the read returns: it holds
what the read could see, so an event the read saw is never a conflict, however recent ([ADR-0048](../../adr/0048-a-conflict-is-what-the-read-did-not-see.md)).
A refused decision is decided again by reading again; here up to three times, with `Effect.retry`.

<!-- file: packages/eventstore/test/support/direct-use.ts#decide -->
```ts
// What a lend depends on: the copy's loans and returns.
const copyEvents = (copyId: string) => Query.of(Query.queryItemOf(["CopyLent", "CopyReturned"], [{ key: "copy_id", value: copyId }]));

export const lendCopy = (copyId: string, memberId: string) =>
  Effect.gen(function* () {
    const es = yield* EventStore;
    // 1. Read what the decision depends on, and where the read stopped.
    const { events, position } = yield* readToDecide(copyEvents(copyId));
    // 2. Decide.
    const lent = events.filter((e) => e.type === "CopyLent").length > events.filter((e) => e.type === "CopyReturned").length;
    if (lent) return yield* new CopyNotAvailable({ copyId });
    // 3. Append, refused if anything the decision depends on was appended after the read.
    return yield* es.append(
      [AppendEvent.builder("CopyLent").tag("copy_id", copyId).tag("member_id", memberId).data({ copyId, memberId }).build()],
      AppendCondition.failIfEventsMatch(copyEvents(copyId), { after: position })
    );
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
    const es = yield* EventStore;
    const query = Query.forEventAndTag("CopyLent", "member_id", memberId);
    let page = yield* es.read(query, { limit: 100 });
    const loans = [...page.events];
    while (page.more) {
      page = yield* es.read(query, { after: page.cursor, limit: 100 });
      loans.push(...page.events);
    }
    return loans;
  });

// The same as a stream, which asks for the pages itself.
export const loanCount = (memberId: string) => Stream.runCount(stream(Query.forEventAndTag("CopyLent", "member_id", memberId), { batchSize: 100 }));
```

A page holds only events whose transaction had finished, so resuming from its cursor never skips one, even one that commits late. The other side: while
a transaction stays open anywhere in the database, a page stops before the events written after it began, and `more: false` means "no more finished
events now", not "no more events". A stream ends when it has caught up; to follow the log as it grows, [add a view](add-a-view.md) or an
[automation](add-an-automation.md), which are woken by new events.

To read every event, use `Query.all()`; a query with no items is refused by these reads. In a condition, `Query.all()` refuses the append for any
event at all after the position, and it waits for every other writer: keep it for a rule that really is about the whole log.

## Several appends together

`transaction(effect)` runs the effect in one database transaction and wakes the processors once it has committed; if the effect fails, nothing it
appended is stored and nothing is announced.

<!-- file: packages/eventstore/test/support/direct-use.ts#transaction -->
```ts
// Two appends that stand or fall together: one transaction, and the processors are woken once it has committed.
export const lendTwo = (first: string, second: string, memberId: string) =>
  Effect.flatMap(Effect.service(EventStore), (es) => es.transaction(Effect.andThen(lendCopy(first, memberId), lendCopy(second, memberId))));
```

Within one transaction an append is not refused for events that same transaction appended earlier: a decision that depends on what you just wrote
should read again after writing. To refuse an append that is not its transaction's first write, as commands do, use
`AppendCondition.firstWrite(condition)` ([the compatibility notes](../../concepts/dcb-guide.md#compatibility-with-the-specification)).

## Limits

- One append takes at most `maxAppendEvents` events, 50 unless configured ([keep an append small](../operate/run-in-production.md#keep-an-append-small)).
- A query item targets events by type and/or tags; one with neither is refused.
- A tag's key and value may hold any characters, and a tag repeated on an event is stored once.

The code of this guide is [`direct-use.ts`](../../../packages/eventstore/test/support/direct-use.ts), run in memory and on Postgres, with two lends of
one copy raced ([ADR-0050](../../adr/0050-the-event-store-used-directly.md)).
