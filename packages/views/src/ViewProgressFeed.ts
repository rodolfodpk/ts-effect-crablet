import { Effect, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { VIEW_PROGRESS_CHANNEL, decodeViewProgressPing, type ViewProgressPing } from "./ViewProgress.ts";

// A stream of "this view moved" pings for the named views, from the database's LISTEN on the views' progress channel. It holds one
// dedicated connection while it runs and gives it back when the stream ends (a closed browser tab, an interrupt). A ping is a hint, not
// stored: a consumer that was not listening missed it, so it re-reads on connecting.
//
// The stream OPENS with where each named view is now (one ping per view that has progress), read AFTER the listener is confirmed, so
// nothing between the two is missed. That is the connection's first data (an SSE response is only sent to the client once it has a
// first chunk) and the page's cue to read once on every (re)connect. A payload that does not decode is dropped (it
// cannot be from this module's tracker).
export const viewProgressFeed = (names: ReadonlySet<string>): Stream.Stream<ViewProgressPing, never, PgClient.PgClient | SqlClient.SqlClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const pg = yield* PgClient.PgClient;
      const sql = yield* SqlClient.SqlClient;
      const queue = yield* pg.listen(VIEW_PROGRESS_CHANNEL);
      const current = yield* sql.unsafe<{ view_name: string; transaction_id: string; position: string }>(
        "SELECT view_name, last_transaction_id::text AS transaction_id, last_position::text AS position FROM crablet_view_progress WHERE view_name = ANY($1::text[])",
        [[...names]]
      ).pipe(Effect.orDie);
      const opening = current.map((row): ViewProgressPing => ({ id: row.view_name, transactionId: row.transaction_id, position: row.position }));
      return Stream.fromIterable(opening).pipe(Stream.concat(Stream.fromQueue(queue).pipe(
        Stream.mapEffect((notification) =>
          decodeViewProgressPing(notification.payload).pipe(
            Effect.map((ping): ReadonlyArray<ViewProgressPing> => [ping]),
            Effect.orElseSucceed((): ReadonlyArray<ViewProgressPing> => [])
          )
        ),
        Stream.flattenIterable,
        Stream.filter((ping) => names.has(ping.id))
      )));
    })
  ).pipe(Stream.orDie);
