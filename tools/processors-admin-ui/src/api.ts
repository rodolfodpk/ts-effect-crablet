// The page's view of the processors admin API: the calls it makes, and what can go wrong with each.
//
// Everything about the wire format comes from @crablet/processors-http (the same group a server mounts): the routes, the response Schemas and the problems. The derived client
// is typed by it, so this file keeps no copy of any of it, and it knows nothing about any application: the page works against anything that mounts the group.
// It imports no foldkit, so tests and the end-to-end check can use it.
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApi, HttpApiClient } from "effect/http-api";
import { ProcessorInfo, processorsGroup } from "@crablet/processors-http";

export { ProcessorInfo };

export const adminApi = HttpApi.make("processorsAdmin").add(processorsGroup);

// #region client
// Where the API is. Unset: relative URLs, which works when the page and the API share an origin (the Vite dev proxy does that). With VITE_API_URL set the page calls that origin
// directly, which needs CORS on the server. `import.meta.env` is Vite's (and Bun's); under plain Node, as in the integration test, it is absent and the base is relative.
export const apiBaseUrl: string | undefined = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL || undefined;

// Every request carries the bearer token the person typed. It lives in the page's memory only: nothing is stored, and a reload asks again.
const makeClient = (token: string) =>
  HttpApiClient.make(adminApi, {
    ...(apiBaseUrl === undefined ? {} : { baseUrl: apiBaseUrl }),
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token))
  });
// #endregion client

// #region calls
export const listCall = (token: string) =>
  Effect.gen(function* () {
    const client = yield* makeClient(token);
    return (yield* client.processors.listProcessors()).processors;
  });

export type Action = "pause" | "resume" | "reset";

// Pause, resume or reset one processor. `kind` and `id` are whatever the application named them; the id is percent-encoded into the path by the client.
export const actCall = (token: string, action: Action, kind: string, id: string) =>
  Effect.gen(function* () {
    const client = yield* makeClient(token);
    const params = { params: { kind, id } };
    switch (action) {
      case "pause":
        return yield* client.processors.pauseProcessor(params);
      case "resume":
        return yield* client.processors.resumeProcessor(params);
      case "reset":
        return yield* client.processors.resetProcessor(params);
    }
  });
// #endregion calls

// PROBLEMS: what a call can fail with, as the page understands it.

// #region problems
export const Problem = Schema.Union([
  // 401: no token, or one the application refused.
  Schema.TaggedStruct("Unauthorized", {}),
  // 404: the application has no such kind or processor (it may have been renamed or removed since the list was read).
  Schema.TaggedStruct("NotFound", { detail: Schema.String }),
  // The derived client checks the answer against the API's own Schema; a failure names the field.
  Schema.TaggedStruct("Mismatch", { detail: Schema.String }),
  Schema.TaggedStruct("Unreachable", {})
]);
export type Problem = typeof Problem.Type;

export type CallError = Effect.Error<ReturnType<typeof listCall>> | Effect.Error<ReturnType<typeof actCall>>;

export const problemFromError = (error: CallError): Problem => {
  if (Schema.isSchemaError(error)) return { _tag: "Mismatch", detail: error.message };
  // The only answers with a status are the two problems the API declares (401 from the authorization, 404 from an action); a third one added to the API
  // would not compile here: `error` would not be `never` after these two.
  if ("status" in error) {
    if (error.status === 401) return { _tag: "Unauthorized" };
    if (error.status === 404) return { _tag: "NotFound", detail: error.detail };
    const unhandled: never = error;
    return unhandled;
  }
  return { _tag: "Unreachable" };
};
// #endregion problems
