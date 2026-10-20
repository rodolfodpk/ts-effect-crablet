import { Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { HttpApi, HttpApiGroup } from "effect/http-api";
import type { AnyCommandContract } from "@crablet/commands/Contract";
import { apiDocsLayer, apiLayerOptions } from "./ApiDescription.ts";
import type { Implementations } from "./CommandApi.ts";
import type { CommandApiConfig } from "./CommandApiConfig.ts";
import { makeCommandApiGroupLive } from "./CommandApiLive.ts";
import { corsLayer, type CorsConfig } from "./Cors.ts";

// One API, served: its write group from the commands, the application's other groups (reads, a live feed), the OpenAPI document, an optional
// documentation page and CORS, in one layer to give to `HttpRouter.serve`.
//
//     const served = serveApi(api, {
//       commands: { contracts: courseContracts, implementations: { define_course: DefineCourse, subscribe: Subscribe } },
//       groups: [makeCourseQueryApiLive(api), makeCourseFeedApiLive(api, { views: [CourseSeatsView] })],
//       docs: { ui: "scalar" }
//     }).pipe(Layer.provide(ViewProgressHubLive));
//
// A group the api declares and `groups` does not implement stays in the layer's requirements, so serving it does not compile. What the groups need
// is left to the caller and is provided once for all of them: the reads and the feed share one `ViewProgressHub` (one database LISTEN, ADR-0016) when
// it is provided to this layer, not to each group.
export interface ServeApiOptions<C extends ReadonlyArray<AnyCommandContract>, G extends ReadonlyArray<Layer.Any>> {
  // The api's write group (`makeCommandApiGroup(basePath, contracts)`): its contracts and the command built from each, checked as
  // `makeCommandApiGroupLive` checks them. `basePath` must be the one the group was made with.
  readonly commands: {
    readonly contracts: C;
    readonly implementations: Implementations<C>;
    readonly basePath?: string;
    readonly correlationHeaderEnabled?: boolean;
  };
  // The implementations of the api's other groups, each from `HttpApiBuilder.group(api, name, ...)`.
  readonly groups?: G;
  // Where the OpenAPI document is served (default "/openapi.json"; false = none), and an optional documentation page.
  readonly openApiPath?: CommandApiConfig["openApiPath"];
  readonly docs?: CommandApiConfig["docs"];
  // CORS for a page served from another origin. Off unless set (see Cors.ts).
  readonly cors?: CorsConfig;
}

export const serveApi = <
  Id extends string,
  Groups extends HttpApiGroup.Constraint,
  const C extends ReadonlyArray<AnyCommandContract>,
  const G extends ReadonlyArray<Layer.Any> = []
>(
  api: HttpApi.HttpApi<Id, Groups>,
  options: ServeApiOptions<C, G>
) => {
  const config: CommandApiConfig = {
    ...(options.commands.basePath !== undefined ? { basePath: options.commands.basePath } : {}),
    ...(options.commands.correlationHeaderEnabled !== undefined ? { correlationHeaderEnabled: options.commands.correlationHeaderEnabled } : {}),
    ...(options.openApiPath !== undefined ? { openApiPath: options.openApiPath } : {}),
    ...(options.docs !== undefined ? { docs: options.docs } : {})
  };
  const commands = makeCommandApiGroupLive(api, options.commands.contracts, options.commands.implementations, config);
  const groups = [commands, ...(options.groups ?? [])] as unknown as [typeof commands, ...G];
  const served = Layer.merge(HttpApiBuilder.layer(api, apiLayerOptions(config)).pipe(Layer.provide(groups)), apiDocsLayer(api, config));
  return options.cors === undefined ? served : Layer.merge(served, corsLayer(options.cors));
};
