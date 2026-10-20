import { Duration, Effect, Stream } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { CommandApiBadRequest } from "@crablet/commands-http/ProblemDetail";
import { viewProgressFeed } from "@crablet/views/ViewProgressFeed";
import type { SqlClient } from "effect/sql";
import type { ViewProgressHub } from "@crablet/views/ViewProgressHub";
import type { CourseApi } from "../CourseApi.ts";

// A connection is ended after this long and the page reconnects (the Subscription does it by itself), so no proxy or load balancer holds
// one for ever.
export const defaultMaxFeedLifetime = Duration.minutes(5);

// The views the feed may be asked about (`defineView`'s results, as a consistent read takes them): a request names them, and an unknown name is a
// 400 (a typo would otherwise be a silent, never-firing connection).
export interface CourseFeedOptions {
  readonly views: ReadonlyArray<{ readonly name: string }>;
  readonly maxLifetime?: Duration.Input;
}

// `?views=a,b` -> the names, or null when empty or not all known.
export const parseFeedViews = (raw: string, known: ReadonlySet<string>): ReadonlySet<string> | null => {
  const names = raw.split(",").map((n) => n.trim()).filter((n) => n !== "");
  return names.length > 0 && names.every((n) => known.has(n)) ? new Set(names) : null;
};

// The live feed group, implemented against the course API itself. It needs a `ViewProgressHub`: provide one for the whole API, so the feed and
// the reads share it (serveApi, CourseApp.ts).
export const makeCourseFeedApiLive = (api: CourseApi, options: CourseFeedOptions) => {
  const known = new Set(options.views.map((v) => v.name));
  const maxLifetime = options.maxLifetime ?? defaultMaxFeedLifetime;
  return HttpApiBuilder.group(api, "courseFeed", (handlers) =>
    Effect.gen(function* () {
      // The streams run after their handler returns, so they are given the group's services (the hub, the database), taken once when the
      // group is built: providing the hub to the whole API (serveApi) then gives every connection the same one.
      const services = yield* Effect.context<ViewProgressHub | SqlClient.SqlClient>();
      return handlers.handle("viewChanges", ({ query }) =>
        Effect.gen(function* () {
          const names = parseFeedViews(query.views, known);
          if (names === null) {
            return yield* Effect.fail(CommandApiBadRequest.of(`views must name one or more of: ${[...known].join(", ")}`));
          }
          return viewProgressFeed(names).pipe(
            Stream.map((ping) => ({ view: ping.id, transactionId: ping.transactionId, position: ping.position })),
            Stream.interruptWhen(Effect.sleep(maxLifetime)),
            Stream.provideContext(services)
          );
        })
      );
    })
  );
};
