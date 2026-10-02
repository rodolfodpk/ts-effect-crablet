import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { BadRequestProblem } from "@crablet/commands-http";

// #region feed-api
// What the feed sends: a view moved. It is a hint to read again, carrying no data of its own: `transactionId` and `position` are the view's
// progress cursor, in the same form as a write's (`lastTransactionId`, `lastPosition`), so a page holding its write's marker can tell when
// the view has caught up to it. Both are strings (the position is a bigint; JSON cannot carry one).
export const ViewAdvanced = Schema.Struct({
  view: Schema.String,
  transactionId: Schema.String,
  position: Schema.String
});

// A feed is a stream of server-sent events: one connection, left open. Pings are not stored: one sent while a page was not connected is
// missed, so a page reads again whenever it (re)connects. The server also ends each connection after a maximum lifetime and the page
// reconnects, so a proxy or load balancer never holds one for ever.
export const courseFeedGroup = HttpApiGroup.make("courseFeed").add(
  HttpApiEndpoint.get("viewChanges", "/api/views/changes", {
    query: {
      views: Schema.String.annotate({ description: "The views to watch, comma-separated (for example `course-seats-view`). One connection can watch several." } as never)
    },
    success: HttpApiSchema.StreamSse({ data: ViewAdvanced }),
    error: BadRequestProblem
  })
);
// #endregion feed-api
