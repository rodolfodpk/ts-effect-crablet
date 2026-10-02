import { Duration, Effect, Layer, Stream } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { HttpApi, HttpApiGroup } from "effect/http-api";
import type { SqlClient } from "effect/sql";
import type { PgClient } from "@effect/sql-pg";
import { CommandApiBadRequest } from "@crablet/commands-http/ProblemDetail";
import { viewProgressFeed } from "@crablet/views/ViewProgressFeed";

// A connection is ended after this long and the page reconnects (the Subscription does it by itself), so no proxy or load balancer holds
// one for ever.
export const defaultMaxFeedLifetime = Duration.minutes(5);

// The views the feed may be asked about: an unknown name is a 400 (a typo would otherwise be a silent, never-firing connection).
export interface CourseFeedOptions {
  readonly views: ReadonlyArray<string>;
  readonly maxLifetime?: Duration.Input;
}

// `?views=a,b` -> the names, or null when empty or not all known.
export const parseFeedViews = (raw: string, known: ReadonlySet<string>): ReadonlySet<string> | null => {
  const names = raw.split(",").map((n) => n.trim()).filter((n) => n !== "");
  return names.length > 0 && names.every((n) => known.has(n)) ? new Set(names) : null;
};

// Same `any`-cast composability boundary as the other Live groups.
export const makeCourseFeedApiLive = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  options: CourseFeedOptions
): Layer.Layer<HttpApiGroup.Service<ApiId, "courseFeed">, never, PgClient.PgClient | SqlClient.SqlClient> => {
  const known = new Set(options.views);
  const maxLifetime = options.maxLifetime ?? defaultMaxFeedLifetime;
  const groupBuilder = HttpApiBuilder.group as any;
  return groupBuilder(api, "courseFeed", (handlers: any) =>
    Effect.succeed(
      handlers.handle("viewChanges", ({ query }: { query: { views: string } }) =>
        Effect.gen(function* () {
          const names = parseFeedViews(query.views, known);
          if (names === null) {
            return yield* Effect.fail(CommandApiBadRequest.of(`views must name one or more of: ${[...known].join(", ")}`));
          }
          return viewProgressFeed(names).pipe(
            Stream.map((ping) => ({ view: ping.id, transactionId: ping.transactionId, position: ping.position })),
            Stream.interruptWhen(Effect.sleep(maxLifetime))
          );
        })
      )
    )
  );
};
