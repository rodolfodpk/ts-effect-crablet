// The live feed served: the `viewChanges` handler of the group LiveFeedApi.ts declares. The application registers it under its group's name in one line:
//
//   HttpApiBuilder.group(api, "courseFeed", (h) => Effect.map(liveFeedHandler({ views: [CourseSeatsView] }), (feed) => h.handle("viewChanges", feed)))
//
// The handler is typed against an API of this group alone, not against the application's: `HttpApiBuilder.group` cannot be typed over an API it does
// not know (the group would be an `Extract` of a type parameter), and a cast would hide what the handler needs.
import { Duration, Effect, Stream } from "effect";
import type { SqlClient } from "effect/sql";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { CommandApiBadRequest } from "@crablet/commands-http/ProblemDetail";
import { viewProgressFeed } from "@crablet/views/ViewProgressFeed";
import type { ViewProgressHub } from "@crablet/views/ViewProgressHub";
import { liveFeedGroup } from "./LiveFeedApi.ts";


// A connection is ended after this long and the page reconnects (the Subscription does it by itself), so no proxy or load balancer holds
// one for ever.
export const defaultMaxFeedLifetime = Duration.minutes(5);

// The views the feed may be asked about (`defineView`'s results, as a consistent read takes them): a request names them, and an unknown name is a
// 400 (a typo would otherwise be a silent, never-firing connection).
export interface LiveFeedOptions {
  readonly views: ReadonlyArray<{ readonly name: string }>;
  readonly maxLifetime?: Duration.Input | undefined;
}

// `?views=a,b` -> the names, or null when empty or not all known.
export const parseFeedViews = (raw: string, known: ReadonlySet<string>): ReadonlySet<string> | null => {
  const names = raw.split(",").map((n) => n.trim()).filter((n) => n !== "");
  return names.length > 0 && names.every((n) => known.has(n)) ? new Set(names) : null;
};

const feedApi = HttpApi.make("liveFeed").add(liveFeedGroup("liveFeed"));

// The `viewChanges` handler. Run it where the group is built: the streams run after their handler returns, so they are given the services (the hub,
// the database) taken then, once; providing the hub to the whole API (serveApi) gives every connection the same one, shared with the reads' wait.
export const liveFeedHandler = (options: LiveFeedOptions) => {
  const known = new Set(options.views.map((v) => v.name));
  const maxLifetime = options.maxLifetime ?? defaultMaxFeedLifetime;
  return Effect.map(Effect.context<ViewProgressHub | SqlClient.SqlClient>(), (services) =>
    HttpApiBuilder.handler(feedApi, "liveFeed", "viewChanges", ({ query }) =>
      Effect.gen(function* () {
        const names = parseFeedViews(query.views, known);
        if (names === null) return yield* Effect.fail(CommandApiBadRequest.of(`views must name one or more of: ${[...known].join(", ")}`));
        return viewProgressFeed(names).pipe(
          Stream.map((ping) => ({ view: ping.id, transactionId: ping.transactionId, position: ping.position })),
          Stream.interruptWhen(Effect.sleep(maxLifetime)),
          Stream.provideContext(services)
        );
      })
    )
  );
};
