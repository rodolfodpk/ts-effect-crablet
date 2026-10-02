import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import type { PgClient } from "@effect/sql-pg";
import { HttpApiBuilder } from "effect/http-api";
import { apiDocsLayer, apiLayerOptions } from "@crablet/commands-http/ApiDescription";
import { corsLayer, type CorsConfig } from "@crablet/commands-http/Cors";
import { makeCommandApiGroupLive } from "@crablet/commands-http/CommandApiLive";
import type { EventStore } from "@crablet/eventstore";
import { defaultInstanceId } from "@crablet/event-poller/InstanceId";
import type { EventProcessorHandle } from "@crablet/event-poller";
import type { ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import { makeViewsProcessor } from "@crablet/views";
import type { ViewsConfig } from "@crablet/views/ViewsConfig";
import { waitUntilProcessed } from "@crablet/views/WaitUntilProcessed";
import type { ViewWaiter } from "@crablet/commands-http/ViewWaiter";
import { COURSE_SEATS_VIEW, courseContracts, makeCourseApi } from "./CourseApi.ts";
import type { Implementations } from "@crablet/commands-http";
import { DefineCourse, Subscribe } from "./domain/Enrolment.ts";
import { makeCourseQueryApiLive } from "./api/CourseQueryApiLive.ts";
import { courseSeatsViewSubscription, makeCourseSeatsViewProjector } from "./views/CourseSeatsViewProjector.ts";

// The API definition lives in CourseApi.ts (browser-safe); re-exported so existing imports keep working.
export { courseApiInfo, makeCourseApi } from "./CourseApi.ts";

// #region implementations
// The server's side of the contracts: the command built from each one. A missing or extra command does not compile, and one that was not
// built from its contract is refused when the layer is built.
const courseImplementations: Implementations<typeof courseContracts> = { define_course: DefineCourse, subscribe: Subscribe };
// #endregion implementations

export interface CourseAppConfig {
  readonly basePath?: string;
  // Where the OpenAPI document is served (default "/openapi.json"; false = none) and an optional documentation page.
  readonly openApiPath?: string | false;
  readonly docs?: { readonly ui: "scalar" | "swagger"; readonly path?: string };
  // CORS for a page served from ANOTHER origin (a different host or port). Off unless set: a page behind a dev proxy, or served by
  // this server, needs none. See @crablet/commands-http/Cors.
  readonly cors?: CorsConfig;
}

// #region wait-for
// The views a write request may wait for (`?waitFor=course-seats-view`): the response is then sent only once that view has
// processed the write, so the caller's next read is not stale. commands-http never imports the views package; this
// map is the whole connection.
const courseViewWaiters: Readonly<Record<string, ViewWaiter>> = {
  [COURSE_SEATS_VIEW]: (write, { timeout }) => waitUntilProcessed(courseSeatsViewSubscription, write, { timeout })
};
// #endregion wait-for

// Serves the API, its OpenAPI document and, when asked for, a documentation page.
export const makeCourseApiLayer = (config: CourseAppConfig = {}) => {
  const basePath = (config.basePath ?? "/api/commands") as `/${string}`;
  const api = makeCourseApi(basePath);
  const commandsLive = makeCommandApiGroupLive(api, courseContracts, courseImplementations, { basePath, viewWaiters: courseViewWaiters });
  const queryLive = makeCourseQueryApiLive(api);
  const served = Layer.merge(
    HttpApiBuilder.layer(api, apiLayerOptions(config)).pipe(Layer.provide(commandsLive), Layer.provide(queryLive)),
    apiDocsLayer(api, config)
  );
  return config.cors === undefined ? served : Layer.merge(served, corsLayer(config.cors));
};

const viewsConfig: ViewsConfig = {
  enabled: true,
  pollingIntervalMs: 1000,
  batchSize: 100,
  backoffEnabled: true,
  backoffThreshold: 3,
  backoffMultiplier: 2,
  backoffMaxSeconds: 120,
  leaderElectionRetryIntervalMs: 30_000,
  maxErrors: 10
};

// Starts the background view processor (an append wakes it through LISTEN/NOTIFY; the poll interval is the fallback).
// Building its Layer alone would NOT process anything: `.service.start` forks the long-lived fibers that do the work, and
// they are only stopped by `.service.stop` - call it before closing the database pool.
//
// `viewDelayMs` is a DEMO knob (default 0, off): it holds every batch back that long before the view applies it, so a read
// made right after a write is visibly stale and `?waitFor=course-seats-view` has something to show. The delay is spent
// BEFORE the projector's transaction opens, so no database transaction sits open while it waits.
export interface CourseViewsOptions {
  readonly viewDelayMs?: number;
}

export const startCourseViews = (
  instanceId: string = defaultInstanceId(),
  options: CourseViewsOptions = {}
): Effect.Effect<EventProcessorHandle<ProcessorConfig<string>, string>, never, SqlClient.SqlClient | PgClient.PgClient | EventStore> =>
  Effect.gen(function* () {
    const projector = yield* makeCourseSeatsViewProjector();
    const delayMs = options.viewDelayMs ?? 0;
    const handle = yield* makeViewsProcessor({
      config: viewsConfig,
      projectors: [delayMs > 0 ? { ...projector, handle: (events) => Effect.andThen(Effect.sleep(`${delayMs} millis`), projector.handle(events)) } : projector],
      subscriptions: [courseSeatsViewSubscription],
      instanceId
    });
    yield* handle.service.start;
    return handle;
  });
