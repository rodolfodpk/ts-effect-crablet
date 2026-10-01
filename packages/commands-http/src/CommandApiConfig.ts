import type { ViewWaiter } from "./ViewWaiter.ts";

// Everything is optional: basePath defaults to "/api/commands", correlation header handling is off
// unless explicitly enabled, the API description is served at "/openapi.json" (`false` turns it off), and
// no documentation page is mounted unless `docs` asks for one.
export interface CommandApiConfig {
  readonly basePath?: string;
  readonly correlationHeaderEnabled?: boolean;
  // Where the OpenAPI document is served (GET, JSON). `false` serves none.
  readonly openApiPath?: string | false;
  // A browsable documentation page rendered from that description. Off by default: enable it
  // deliberately (it is meant for development and internal use, not as a public surface by default).
  readonly docs?: { readonly ui: "scalar" | "swagger"; readonly path?: string };
  // Views a request may wait for before it is answered (`?waitFor=<name>`), so that its response is not stale.
  // Empty or absent: no waiting offered, and the parameter is not part of the API description.
  readonly viewWaiters?: Readonly<Record<string, ViewWaiter>>;
}

export const defaultBasePath = "/api/commands";
export const defaultOpenApiPath = "/openapi.json";
