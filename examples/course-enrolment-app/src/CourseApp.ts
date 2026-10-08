import { Effect, Layer, type Duration } from "effect";
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
import { ViewProgressHubLive, type ViewProgressHub } from "@crablet/views/ViewProgressHub";
import { COURSE_SEATS_VIEW, courseContracts, makeCourseApi } from "./CourseApi.ts";
import type { Implementations } from "@crablet/commands-http";
import { DefineCourse, Subscribe } from "./domain/Enrolment.ts";
import { makeCourseFeedApiLive } from "./api/CourseFeedApiLive.ts";
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
  // How long a live-update connection (GET /api/views/changes) lives before the server ends it and the page reconnects (default 5 minutes).
  readonly maxFeedLifetime?: Duration.Input;
  // The view progress hub the feed and the reads' wait share (default `ViewProgressHubLive`: one database LISTEN for the process, ADR-0016). It can be
  // replaced, for example by a hub that is never connected to compare the polling wait with the hub's (scripts/bench-reads.ts).
  readonly viewProgressHub?: Layer.Layer<ViewProgressHub, never, PgClient.PgClient>;
}

// Serves the API, its OpenAPI document and, when asked for, a documentation page.
export const makeCourseApiLayer = (config: CourseAppConfig = {}) => {
  const basePath = (config.basePath ?? "/api/commands") as `/${string}`;
  const api = makeCourseApi(basePath);
  const commandsLive = makeCommandApiGroupLive(api, courseContracts, courseImplementations, { basePath });
  const queryLive = makeCourseQueryApiLive(api);
  const feedLive = makeCourseFeedApiLive(api, { views: [COURSE_SEATS_VIEW], ...(config.maxFeedLifetime !== undefined ? { maxLifetime: config.maxFeedLifetime } : {}) });
  // ONE view progress hub (one database LISTEN) for the whole process, shared by the feed and by the reads' wait (ADR-0016): the same layer value is
  // provided to both, and Effect builds a layer value once per build.
  const hub = config.viewProgressHub ?? ViewProgressHubLive;
  const served = Layer.merge(
    HttpApiBuilder.layer(api, apiLayerOptions(config)).pipe(
      Layer.provide(commandsLive),
      Layer.provide(Layer.provide(queryLive, hub)),
      Layer.provide(Layer.provide(feedLive, hub))
    ),
    apiDocsLayer(api, config)
  );
  return config.cors === undefined ? served : Layer.merge(served, corsLayer(config.cors));
};

// #region views-config
const viewsConfig: ViewsConfig = {
  enabled: true,
  pollingIntervalMs: 1000,
  batchSize: 100,
  backoffEnabled: true,
  backoffThreshold: 3,
  backoffMultiplier: 2,
  backoffMaxSeconds: 120,
  leaderElectionRetryIntervalMs: 5_000,
  maxErrors: 10
};
// #endregion views-config

// Starts the background view processor (an append wakes it through LISTEN/NOTIFY; the poll interval is the fallback).
// Building its Layer alone would NOT process anything: `.service.start` forks the long-lived fibers that do the work, and
// they are only stopped by `.service.stop` - call it before closing the database pool.
//
// `viewDelayMs` is a DEMO knob (default 0, off): it holds every batch back that long before the view applies it, so a read
// made right after a write is visibly stale (`?consistency=eventual`) and a read that carries the write's marker has something to wait for. The delay is spent
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
