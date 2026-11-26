// The live feed's DECLARATION: a stream of "this view moved" pings over server-sent events, for a page that reads again when a view it shows catches
// up (ADR-0016). Nothing here serves it, so a browser can import it (the typed client of an API that adds the group); serving it is LiveFeedLive.ts.
// The group is added to the application's own API, under the name the application picks, so its typed client and its OpenAPI description have it.
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
export const liveFeedGroup = <const Name extends string>(name: Name) =>
  HttpApiGroup.make(name).add(
    HttpApiEndpoint.get("viewChanges", "/api/views/changes", {
      query: {
        views: Schema.String.annotate({ description: "The views to watch, comma-separated (for example `course-seats-view`). One connection can watch several." })
      },
      success: HttpApiSchema.StreamSse({ data: ViewAdvanced }),
      error: BadRequestProblem
    })
  );
// #endregion feed-api
