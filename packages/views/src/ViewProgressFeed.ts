import { Effect, Stream } from "effect";
import { SqlClient } from "effect/sql";
import type { ViewProgressPing } from "./ViewProgress.ts";
import { ViewProgressHub } from "./ViewProgressHub.ts";

// A stream of "this view moved" pings for the named views: a subscription to the view progress hub (ADR-0016), which holds the one database
// LISTEN for the whole process. The feed holds no database connection of its own, so how many are open (a page each) costs memory, not pool slots.
// A ping is a hint, not stored: a consumer that was not listening missed it, so it re-reads on connecting.
//
// The stream OPENS with where each named view is now (one ping per view that has progress), read AFTER the feed has subscribed to the hub, so a
// ping that arrives between the two is waiting in the subscription and nothing is missed. That is the connection's first data (an SSE response
// is only sent to the client once it has a first chunk) and the page's cue to read once on every (re)connect. Whenever the hub's own LISTEN
// reconnects (a ping may have been lost meanwhile) the stream says where the views are again, read from the table, so a lost ping cannot leave a
// page stale.
export const viewProgressFeed = (names: ReadonlySet<string>): Stream.Stream<ViewProgressPing, never, ViewProgressHub | SqlClient.SqlClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const hub = yield* ViewProgressHub;
      const sql = yield* SqlClient.SqlClient;
      const pings = yield* hub.subscribe(names);
      const current = sql.unsafe<{ view_name: string; transaction_id: string; position: string }>(
        "SELECT view_name, last_transaction_id::text AS transaction_id, last_position::text AS position FROM crablet_view_progress WHERE view_name = ANY($1::text[])",
        [[...names]]
      ).pipe(
        Effect.orDie,
        Effect.map((rows): ReadonlyArray<ViewProgressPing> => rows.map((row) => ({ id: row.view_name, transactionId: row.transaction_id, position: row.position })))
      );
      const opening = yield* current;
      // A batch that carries a resync is answered with the current state (which covers every ping in it: they arrived before this read).
      const batches = Stream.fromEffectRepeat(pings.next).pipe(
        Stream.mapEffect((batch) => (batch.resync ? current : Effect.succeed(batch.pings))),
        Stream.flattenIterable
      );
      return Stream.fromIterable(opening).pipe(Stream.concat(batches));
    })
  ).pipe(Stream.orDie);
