import { Layer, type Duration } from "effect";
import type { PgClient } from "@effect/sql-pg";
import type { CorsConfig } from "@crablet/commands-http/Cors";
import { serveApi } from "@crablet/commands-http/ServeApi";
import { ViewProgressHubLive, type ViewProgressHub } from "@crablet/views/ViewProgressHub";
import { courseContracts, makeCourseApi } from "./CourseApi.ts";
import type { Implementations } from "@crablet/commands-http";
import { DefineCourse, Subscribe } from "./slices/enrolment/Enrolment.ts";
import { makeCourseFeedApiLive } from "./api/CourseFeedApiLive.ts";
import { makeCourseQueryApiLive } from "./api/CourseQueryApiLive.ts";
import { CourseSeatsView } from "./slices/course-seats/CourseSeatsViewProjector.ts";

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

// Serves the API: the commands, the reads and the live feed, the OpenAPI document and, when asked for, a documentation page and CORS.
// ONE view progress hub (one database LISTEN) for the whole process, shared by the feed and by the reads' wait (ADR-0016): it is provided once, to
// the whole API.
// #region serve
export const makeCourseApiLayer = (config: CourseAppConfig = {}) => {
  const basePath = (config.basePath ?? "/api/commands") as `/${string}`;
  const api = makeCourseApi(basePath);
  return serveApi(api, {
    commands: { contracts: courseContracts, implementations: courseImplementations, basePath },
    groups: [makeCourseQueryApiLive(api), makeCourseFeedApiLive(api, { views: [CourseSeatsView], maxLifetime: config.maxFeedLifetime })],
    openApiPath: config.openApiPath,
    docs: config.docs,
    cors: config.cors
  }).pipe(Layer.provide(config.viewProgressHub ?? ViewProgressHubLive));
};
// #endregion serve

