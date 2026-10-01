import { Layer } from "effect";
import { HttpApiScalar, HttpApiSwagger } from "effect/http-api";
import type { HttpApi, HttpApiGroup } from "effect/http-api";
import type { CommandApiConfig } from "./CommandApiConfig.ts";
import { defaultOpenApiPath } from "./CommandApiConfig.ts";

// Options for `HttpApiBuilder.layer(api, ...)`: where the OpenAPI document is served (none when `false`).
export const apiLayerOptions = (config: CommandApiConfig): { readonly openapiPath?: `/${string}` } =>
  config.openApiPath === false ? {} : { openapiPath: (config.openApiPath ?? defaultOpenApiPath) as `/${string}` };

// The optional documentation page (Scalar or Swagger UI) for `api`; an empty layer when `docs` is not set.
// Merge it next to the api's own layer before serving the router.
export const apiDocsLayer = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  config: CommandApiConfig
) => {
  if (config.docs === undefined) return Layer.empty;
  const path = (config.docs.path ?? "/docs") as `/${string}`;
  return config.docs.ui === "scalar" ? HttpApiScalar.layer(api, { path }) : HttpApiSwagger.layer(api, { path });
};
