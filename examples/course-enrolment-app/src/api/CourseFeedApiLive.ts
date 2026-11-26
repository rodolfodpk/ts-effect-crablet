import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { liveFeedHandler, type LiveFeedOptions } from "@crablet/views-http/LiveFeedLive";
import type { CourseApi } from "../CourseApi.ts";

// The live feed group, registered against the course API. It needs a `ViewProgressHub`: provide one for the whole API, so the feed and the reads
// share it (serveApi, CourseApp.ts).
export const makeCourseFeedApiLive = (api: CourseApi, options: LiveFeedOptions) =>
  HttpApiBuilder.group(api, "courseFeed", (handlers) => Effect.map(liveFeedHandler(options), (feed) => handlers.handle("viewChanges", feed)));
