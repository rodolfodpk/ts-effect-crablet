// The event store used directly, without the command framework: the code of docs/guides/build/use-the-event-store-directly.md (its blocks are these
// regions, checked by guides-sync.test.ts). A library lends copies: lending a copy that is out is refused; returning one makes it available again.
// Run in memory (test/direct-use.test.ts) and on Postgres (test/integration/direct-use.test.ts).
import { Data, Effect, Schedule, Stream } from "effect";
import * as AppendCondition from "../../src/AppendCondition.ts";
import * as AppendContext from "../../src/AppendContext.ts";
import * as AppendEvent from "../../src/AppendEvent.ts";
import { Conflict } from "../../src/AppendErrors.ts";
import { EventStore, readToDecide, stream } from "../../src/EventStore.ts";
import * as Query from "../../src/Query.ts";

export class CopyNotAvailable extends Data.TaggedError("CopyNotAvailable")<{ readonly copyId: string }> {}

// #region decide
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
// #endregion decide

export const returnCopy = (copyId: string, memberId: string) =>
  Effect.flatMap(Effect.service(EventStore), (es) =>
    es.append([AppendEvent.builder("CopyReturned").tag("copy_id", copyId).tag("member_id", memberId).data({ copyId, memberId }).build()])
  );

// #region read
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
// #endregion read

// #region context
// A lend asked for at the front desk: its events carry the request's correlation id (from the caller's header, say) and metadata saying where it
// came from. The framework records both; it reads neither.
export const lendAtTheDesk = (copyId: string, memberId: string, requestId: string) =>
  lendCopy(copyId, memberId).pipe(AppendContext.withCorrelationId(requestId), AppendContext.withMetadata({ source: "front-desk" }));
// #endregion context

// #region transaction
// Two appends that stand or fall together: one transaction, and the processors are woken once it has committed.
export const lendTwo = (first: string, second: string, memberId: string) =>
  Effect.flatMap(Effect.service(EventStore), (es) => es.transaction(Effect.andThen(lendCopy(first, memberId), lendCopy(second, memberId))));
// #endregion transaction
