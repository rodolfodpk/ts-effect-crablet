import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import type { PgClient } from "@effect/sql-pg";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { makeCommandApiGroup, withApiInfo } from "@crablet/commands-http";
import { apiDocsLayer, apiLayerOptions } from "@crablet/commands-http/ApiDescription";
import { makeCommandApiGroupLive } from "@crablet/commands-http/CommandApiLive";
import { exposedCommandOf, type ExposedCommand } from "@crablet/commands-http/ExposedCommand";
import type { EventStore } from "@crablet/eventstore";
import { defaultInstanceId } from "@crablet/event-poller/InstanceId";
import type { EventProcessorHandle } from "@crablet/event-poller";
import type { ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import { makeViewsProcessor } from "@crablet/views";
import type { ViewsConfig } from "@crablet/views/ViewsConfig";
import { waitUntilProcessed } from "@crablet/views/WaitUntilProcessed";
import type { ViewWaiter } from "@crablet/commands-http/ViewWaiter";
import { DefineCourse, Subscribe } from "./domain/Enrolment.ts";
import { courseQueryGroup } from "./api/CourseQueryApi.ts";
import { makeCourseQueryApiLive } from "./api/CourseQueryApiLive.ts";
import { COURSE_SEATS_VIEW, courseSeatsViewSubscription, makeCourseSeatsViewProjector } from "./views/CourseSeatsViewProjector.ts";

export interface CourseAppConfig {
  readonly basePath?: string;
  // Where the OpenAPI document is served (default "/openapi.json"; false = none) and an optional documentation page.
  readonly openApiPath?: string | false;
  readonly docs?: { readonly ui: "scalar" | "swagger"; readonly path?: string };
}

// #region expose
// The write API: one route per command, POST /api/commands/<name>. A command's declared `errors` are what the API
// presents (status from each error's kind) and documents; there is no HTTP code to write per command.
const courseCommands: Readonly<Record<string, ExposedCommand<any, any>>> = {
  define_course: exposedCommandOf(DefineCourse),
  subscribe: exposedCommandOf(Subscribe)
};
// #endregion expose

// #region wait-for
// The views a write request may wait for (`?waitFor=course-seats-view`): the response is then sent only once that view has
// processed the write, so the caller's next read is not stale. commands-http never imports the views package; this
// map is the whole connection.
const courseViewWaiters: Readonly<Record<string, ViewWaiter>> = {
  [COURSE_SEATS_VIEW]: (position, { timeout }) => waitUntilProcessed(courseSeatsViewSubscription, position, { timeout })
};
// #endregion wait-for

export const courseApiInfo = {
  title: "Course Enrolment API",
  version: "1.0.0",
  description: "Define courses and subscribe students: a course holds at most `capacity` students, a student takes at most 3 courses."
} as const;

// The API (separate from serving it, so its OpenAPI description can be produced without starting anything).
export const makeCourseApi = (basePath: `/${string}` = "/api/commands") =>
  withApiInfo(
    HttpApi.make("courseApp")
      .add(makeCommandApiGroup(basePath, courseCommands, { waitableViews: Object.keys(courseViewWaiters) }))
      .add(courseQueryGroup),
    courseApiInfo
  );

// Serves the API, its OpenAPI document and, when asked for, a documentation page.
export const makeCourseApiLayer = (config: CourseAppConfig = {}) => {
  const basePath = (config.basePath ?? "/api/commands") as `/${string}`;
  const api = makeCourseApi(basePath);
  const commandsLive = makeCommandApiGroupLive(api, courseCommands, { basePath, viewWaiters: courseViewWaiters });
  const queryLive = makeCourseQueryApiLive(api);
  return Layer.merge(
    HttpApiBuilder.layer(api, apiLayerOptions(config)).pipe(Layer.provide(commandsLive), Layer.provide(queryLive)),
    apiDocsLayer(api, config)
  );
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
export const startCourseViews = (
  instanceId: string = defaultInstanceId()
): Effect.Effect<EventProcessorHandle<ProcessorConfig<string>, string>, never, SqlClient.SqlClient | PgClient.PgClient | EventStore> =>
  Effect.gen(function* () {
    const handle = yield* makeViewsProcessor({
      config: viewsConfig,
      projectors: [yield* makeCourseSeatsViewProjector()],
      subscriptions: [courseSeatsViewSubscription],
      instanceId
    });
    yield* handle.service.start;
    return handle;
  });
