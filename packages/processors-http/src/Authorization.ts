import { Effect, Layer, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { HttpApiMiddleware, HttpApiSchema, HttpApiSecurity } from "effect/http-api";

// Who may call the admin API. The framework does not decide: every endpoint of the group requires this service, so an application that mounts the API
// has to provide an implementation, or the server fails to start with "Service not found: ...ProcessorsAuthorization" (it fails closed; the layer's TYPE does not show the
// requirement, so this is a start-up error, not a compile error). Reset restarts a FAILED processor, and pause stops one: not for an open port.

export const ProcessorsUnauthorizedType = "urn:crablet:problem:processors-api:unauthorized";

export class ProcessorsUnauthorized extends Schema.Class<ProcessorsUnauthorized>("ProcessorsUnauthorized")(
  {
    type: Schema.Literal(ProcessorsUnauthorizedType),
    title: Schema.Literal("Unauthorized"),
    status: Schema.Literal(401),
    detail: Schema.String
  },
  { httpApiStatus: 401 }
) {
  static of(detail: string): ProcessorsUnauthorized {
    return new ProcessorsUnauthorized({ type: ProcessorsUnauthorizedType, title: "Unauthorized", status: 401, detail });
  }
}

// A bearer token is how a caller proves itself (the security scheme appears in the OpenAPI description). What the token means is the implementation's business.
export class ProcessorsAuthorization extends HttpApiMiddleware.Service<ProcessorsAuthorization, { provides: never; requires: never }>()(
  "@crablet/processors-http/ProcessorsAuthorization",
  {
    security: { bearer: HttpApiSecurity.bearer },
    error: ProcessorsUnauthorized.pipe(HttpApiSchema.asJson({ contentType: "application/problem+json" }))
  }
) {}

// An implementation from a check on the token: true lets the request through. Use it with whatever your application trusts (a static admin token from the
// environment, a JWT verifier, a lookup in an identity service); a check that FAILS (a lookup that cannot say yes) is a 401, and one that DIES is a 500: neither lets the request through.
// #region authorization-live
export const authorizationFrom = (check: (token: Redacted.Redacted<string>) => Effect.Effect<boolean, unknown>): Layer.Layer<ProcessorsAuthorization> =>
  Layer.succeed(
    ProcessorsAuthorization,
    ProcessorsAuthorization.of({
      bearer: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const allowed = yield* check(credential).pipe(Effect.orElseSucceed(() => false));
          if (!allowed) return yield* Effect.fail(ProcessorsUnauthorized.of("Missing or invalid bearer token"));
          return yield* httpEffect;
        })
    })
  );
// #endregion authorization-live
