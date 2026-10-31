// The event store used directly, without the command framework: the code of docs/guides/build/use-the-event-store-directly.md (its blocks are these
// regions, checked by guides-sync.test.ts). A library lends copies: lending a copy that is out is refused; returning one makes it available again.
// Run in memory (test/direct-use.test.ts) and on Postgres (test/integration/direct-use.test.ts).
// It imports the package by its own name, as an application does.
// #region imports
import { Data, Effect, Layer, Schedule, Stream } from "effect";
import { append, EventStore, read, readToDecide, stream, transaction } from "@crablet/eventstore";
import * as AppendContext from "@crablet/eventstore/AppendContext";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { Conflict } from "@crablet/eventstore/AppendErrors";
import * as Postgres from "@crablet/eventstore/Postgres";
import * as Query from "@crablet/eventstore/Query";
import { makeInMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
// #endregion imports

// #region setup
// A program that uses the store needs `EventStore`; a layer provides it:
//   on Postgres, `Postgres.layer({ host, port, database, username, password })`, on a database the migrations of @crablet/db-migrations were
//   applied to; in a test, `makeInMemoryEventStore().layer`, which passes the same conformance suite.
export const runWith = <LE>(layer: Layer.Layer<EventStore, LE>) => <A, E>(program: Effect.Effect<A, E, EventStore>) =>
  Effect.runPromise(Effect.provide(program, layer));
// #endregion setup

// The two layers the tests run the guide's code with.
export const onPostgres = Postgres.layer;
export const inMemory = () => makeInMemoryEventStore().layer;

export class CopyNotAvailable extends Data.TaggedError("CopyNotAvailable")<{ readonly copyId: string }> {}

// #region decide
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
// #endregion decide

export const returnCopy = (copyId: string, memberId: string) =>
  append([AppendEvent.make("CopyReturned", { copyId, memberId }, { copy_id: copyId, member_id: memberId })]);

// #region read
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
// #endregion read

// #region context
// A lend asked for at the front desk: its events carry the request's correlation id (a uuid, from the caller's header, say) and metadata saying
// where it came from. The framework records both; it reads neither.
export const lendAtTheDesk = (copyId: string, memberId: string, requestId: string) =>
  lendCopy(copyId, memberId).pipe(AppendContext.withCorrelationId(requestId), AppendContext.withMetadata({ source: "front-desk" }));
// #endregion context

// #region transaction
// Two appends that stand or fall together: one transaction, and the processors are woken once it has committed.
export const lendTwo = (first: string, second: string, memberId: string) => transaction(Effect.andThen(lendCopy(first, memberId), lendCopy(second, memberId)));
// #endregion transaction
