import { Layer } from "effect";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { makeCommandApiGroup, withApiInfo } from "@crablet/commands-http";
import { apiDocsLayer, apiLayerOptions } from "@crablet/commands-http/ApiDescription";
import { makeCommandApiGroupLive } from "@crablet/commands-http/CommandApiLive";
import { exposedCommandOf, type ExposedCommand } from "@crablet/commands-http/ExposedCommand";
import { DefineCourse, Subscribe } from "./domain/Enrolment.ts";

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

export const courseApiInfo = {
  title: "Course Enrolment API",
  version: "1.0.0",
  description: "Define courses and subscribe students: a course holds at most `capacity` students, a student takes at most 3 courses."
} as const;

// The API (separate from serving it, so its OpenAPI description can be produced without starting anything).
export const makeCourseApi = (basePath: `/${string}` = "/api/commands") =>
  withApiInfo(HttpApi.make("courseApp").add(makeCommandApiGroup(basePath, courseCommands)), courseApiInfo);

// Serves the API, its OpenAPI document and, when asked for, a documentation page.
export const makeCourseApiLayer = (config: CourseAppConfig = {}) => {
  const basePath = (config.basePath ?? "/api/commands") as `/${string}`;
  const api = makeCourseApi(basePath);
  const commandsLive = makeCommandApiGroupLive(api, courseCommands, { basePath });
  return Layer.merge(HttpApiBuilder.layer(api, apiLayerOptions(config)).pipe(Layer.provide(commandsLive)), apiDocsLayer(api, config));
};
