import { Clock, Duration, Effect, Exit, Metric, Option } from "effect";
import { HttpRouter, HttpServerError, HttpServerRequest } from "effect/http";
import * as HttpMetrics from "@crablet/metrics-otel/HttpMetrics";

// Every request the router serves, counted by method, route and status (ADR-0056): `http.server.request.duration`. A global router middleware,
// so it sees the routes of every layer on the same router (the commands, the reads, the feed, the admin, health), and `serveApi` adds it.
//
// The route is the router's template, read from `HttpRouter.RouteContext` after the handler: `/api/wallets/:walletId`, never the URL (the router
// puts `http.route` on the request's span only under a non-native tracer, so the span is no source). A request that matched no route has no
// `http.route`, as the convention says. A handler that failed reaches here as a failure, not a response: its status is the response the server
// will send for it (`causeResponse`: 404 for no route, 500 for a defect; the synchronous `exitResponse` says 500 for both).
export const requestMetricsLayer = HttpRouter.middleware(
  (app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const start = yield* Clock.currentTimeNanos;
      const exit = yield* Effect.exit(app);
      const end = yield* Clock.currentTimeNanos;
      const route = yield* Effect.serviceOption(HttpRouter.RouteContext);
      const status = Exit.isSuccess(exit) ? exit.value.status : (yield* HttpServerError.causeResponse(exit.cause))[0].status;
      const attributes = {
        "http.request.method": request.method,
        "http.response.status_code": String(status),
        ...Option.match(route, { onNone: () => ({}), onSome: (r) => ({ "http.route": r.route.path }) })
      };
      yield* Metric.update(Metric.withAttributes(HttpMetrics.requestDuration, attributes), Duration.toSeconds(Duration.nanos(end - start)));
      return yield* exit;
    }),
  { global: true }
);
