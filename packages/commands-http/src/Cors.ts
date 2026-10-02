import { Predicate } from "effect";
import { HttpMiddleware, HttpRouter } from "effect/http";

// Opt-in CORS for an app that serves the API to a browser page on ANOTHER origin (a different host or port). When the page and
// the API share an origin (the page is served by the same server, or a dev proxy makes them look like one) none of this is
// needed, and by default nothing here is on: an app that does not call `corsLayer` sends no CORS headers at all.
//
// Why a helper instead of `HttpMiddleware.cors` directly: Effect's own middleware has two permissive defaults that are
// wrong for a write API. An EMPTY `allowedOrigins` list means `Access-Control-Allow-Origin: *` (every origin), and an empty
// `allowedHeaders` list reflects whatever headers the browser asks for. Here the allowed origins are REQUIRED and non-empty,
// the headers and methods are the ones this API uses, and an unsafe combination is refused at construction.
//
// It is router-level middleware (`HttpRouter.middleware(..., { global: true })`), not `HttpRouter.serve({ middleware })`:
// Effect documents that middleware passed to `serve` cannot change the response it wraps, and CORS adds response headers.
// Merge the layer next to the API's own layer before serving:
//
//     const server = HttpRouter.serve(Layer.mergeAll(apiLayer, corsLayer({ allowedOrigins: ["http://localhost:5173"] })))
export interface CorsConfig {
  // The origins allowed to call the API from a browser: exact origins (`https://app.example.org`), or a predicate for a
  // pattern. Required and non-empty. `"*"` (any origin) is allowed only without `credentials`.
  readonly allowedOrigins: readonly [string, ...Array<string>] | Predicate.Predicate<string>;
  // Default: GET and POST, the methods this API uses.
  readonly allowedMethods?: ReadonlyArray<string>;
  // Default: Content-Type and X-Correlation-Id, the request headers this API reads.
  readonly allowedHeaders?: ReadonlyArray<string>;
  // Default: X-Correlation-Id, so a page can read the id the server echoes back.
  readonly exposedHeaders?: ReadonlyArray<string>;
  // How long a browser may cache the preflight answer, in seconds. Default 600.
  readonly maxAge?: number;
  // Send cookies / HTTP auth with cross-origin requests. Needs explicit origins, never `"*"`.
  readonly credentials?: boolean;
}

export const defaultCorsMethods = ["GET", "POST"] as const;
export const defaultCorsHeaders = ["Content-Type", "X-Correlation-Id"] as const;
export const defaultCorsExposedHeaders = ["X-Correlation-Id"] as const;
export const defaultCorsMaxAgeSeconds = 600;

export class InvalidCorsConfig extends Error {
  override readonly name = "InvalidCorsConfig";
}

// Throws `InvalidCorsConfig` for a configuration that would be unsafe or meaningless; returns the layer otherwise.
export const corsLayer = (config: CorsConfig) => {
  const origins = config.allowedOrigins;
  if (typeof origins !== "function") {
    if (!Array.isArray(origins) || origins.length === 0) {
      throw new InvalidCorsConfig("corsLayer needs at least one allowed origin: an empty list would mean every origin");
    }
    if (config.credentials === true && origins.includes("*")) {
      throw new InvalidCorsConfig('corsLayer: credentials cannot be combined with the "*" origin; list the origins explicitly');
    }
  }
  return HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: origins,
      allowedMethods: config.allowedMethods ?? defaultCorsMethods,
      allowedHeaders: config.allowedHeaders ?? defaultCorsHeaders,
      exposedHeaders: config.exposedHeaders ?? defaultCorsExposedHeaders,
      maxAge: config.maxAge ?? defaultCorsMaxAgeSeconds,
      ...(config.credentials !== undefined ? { credentials: config.credentials } : {})
    }),
    { global: true }
  );
};
