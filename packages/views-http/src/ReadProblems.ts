import * as Schema from "effect/Schema";
import { HttpApiSchema } from "effect/http-api";
import type { ViewsOutcome } from "./WaitForViews.ts";

export const ViewsUnavailableType = "urn:crablet:problem:read:views-unavailable";

const UncaughtViewProblem = Schema.Struct({
  name: Schema.String,
  reason: Schema.Literals(["lagging", "view_failed"]),
  // How far the view's progress had got, as a log position; null for a FAILED view.
  reachedPosition: Schema.NullOr(Schema.String)
}).annotate({ identifier: "UncaughtView" } as never);

// A strict read could not be answered consistently: a view it reads had not caught up in time (`lagging`: try again, `Retry-After` says
// when) or is FAILED (`view_failed`: it will not catch up until someone resets it, so there is no `Retry-After`). RFC 7807, status 503.
export class ViewsUnavailable extends Schema.Class<ViewsUnavailable>("ViewsUnavailable")(
  {
    type: Schema.Literal(ViewsUnavailableType),
    title: Schema.Literal("Service Unavailable"),
    status: Schema.Literal(503),
    detail: Schema.String,
    reason: Schema.Literals(["lagging", "view_failed"]),
    views: Schema.Array(UncaughtViewProblem),
    // Also the `Retry-After` header, for clients that read the body. Absent for view_failed.
    retryAfterSeconds: Schema.optionalKey(Schema.Int)
  },
  { httpApiStatus: 503 }
) {
  static of(outcome: Extract<ViewsOutcome, { _tag: "NotCaughtUp" }>, options: { readonly timeoutMs: number; readonly retryAfterSeconds: number }): ViewsUnavailable {
    const names = outcome.views.map((v) => v.name).join(", ");
    return new ViewsUnavailable({
      type: ViewsUnavailableType,
      title: "Service Unavailable",
      status: 503,
      detail:
        outcome.reason === "view_failed"
          ? `A view this read depends on is failed and will not catch up until it is reset: ${names}`
          : `Not caught up within ${options.timeoutMs} ms: ${names}`,
      reason: outcome.reason,
      views: outcome.views,
      ...(outcome.reason === "lagging" ? { retryAfterSeconds: options.retryAfterSeconds } : {})
    });
  }
}

const asProblem = <S extends Schema.Top>(schema: S) => schema.pipe(HttpApiSchema.asJson({ contentType: "application/problem+json" }));

// The schema to declare in an endpoint's `error` list. `Retry-After` is a response header, so the problem is wrapped with it; an endpoint
// cannot declare two responses for one status once one of them has headers (docs/adr/0015), which is why a failed view is this same 503
// with `reason: "view_failed"` and the header left out.
export const ViewsUnavailableProblem = asProblem(ViewsUnavailable).pipe(
  HttpApiSchema.encodeToWithHeaders(
    { body: asProblem(ViewsUnavailable), headers: { "retry-after": Schema.optionalKey(Schema.Int) } },
    {
      decode: ({ body }) => body,
      encode: (problem) => ({
        body: problem,
        headers: problem.retryAfterSeconds === undefined ? {} : { "retry-after": problem.retryAfterSeconds }
      })
    }
  )
);
