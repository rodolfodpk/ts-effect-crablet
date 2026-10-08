import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { ProcessorsAuthorization } from "./Authorization.ts";

// The admin API over the background processors (views, automations, outbox publishers): see what each is doing, and pause, resume or reset one.
// The description only: the handlers are in ProcessorsApiLive.ts. A client can be derived from it, and is typed by it (`HttpApiClient.make`).
//
// Every endpoint is behind `ProcessorsAuthorization` (Authorization.ts): the server does not start until the application provides an implementation that says who may call it.
//
// Evolution rules (the API is a contract an external client is typed against; ADR-0020):
//  - a response gains fields, never loses or retypes one; a client ignores fields it does not know;
//  - a new endpoint or a new optional parameter is fine; changing what an existing endpoint does is not, it gets a new path;
//  - a `kind` and an `id` are whatever the application named them, so nothing here enumerates them.

export const ProcessorStatusSchema = Schema.Literals(["ACTIVE", "PAUSED", "FAILED"]).annotate({
  description: "ACTIVE: running. PAUSED: an operator paused it. FAILED: it stopped after too many errors in a row."
} as never);

export const ProcessorInfo = Schema.Struct({
  kind: Schema.String.annotate({ description: "Which module runs it, as the application named it (for example views, automations, outbox)." } as never),
  id: Schema.String.annotate({ description: "The processor's id within its kind (a view's name; for the outbox a JSON pair [topic, publisher])." } as never),
  description: Schema.NullOr(Schema.String).annotate({ description: "What the processor is for, when the application says." } as never),
  status: ProcessorStatusSchema,
  errorCount: Schema.NullOr(Schema.Finite).annotate({ description: "Errors in a row since the last good batch; null if it has no progress row yet." } as never),
  lastError: Schema.NullOr(Schema.String).annotate({ description: "The text of the last error; null if none." } as never),
  cursorPosition: Schema.NullOr(Schema.String).annotate({ description: "The log position the processor has read up to, as a string (a position is a bigint)." } as never),
  pendingEvents: Schema.NullOr(Schema.Finite).annotate({ description: "Events the processor selects that are waiting after its cursor, counted up to 100 000." } as never),
  pendingCapped: Schema.Boolean.annotate({ description: "True when pendingEvents stopped at its cap: the true number is at least that." } as never),
  oldestPendingSeconds: Schema.NullOr(Schema.Finite).annotate({ description: "Age, by the events' own occurred_at, of the first waiting event; null when none waits." } as never),
  backedOff: Schema.Boolean.annotate({ description: "True while the processor has backed off after errors or empty polls." } as never)
}).annotate({ identifier: "ProcessorInfo" } as never);
export type ProcessorInfo = typeof ProcessorInfo.Type;

export const ProcessorList = Schema.Struct({ processors: Schema.Array(ProcessorInfo) }).annotate({ identifier: "ProcessorList" } as never);

export const ProcessorActionResult = Schema.Struct({
  kind: Schema.String,
  id: Schema.String,
  status: ProcessorStatusSchema
}).annotate({ identifier: "ProcessorActionResult" } as never);

export const ProcessorNotFoundType = "urn:crablet:problem:processors-api:not-found";

// RFC 7807, the same plain Schema.Class pattern as the command API's problems.
export class ProcessorNotFound extends Schema.Class<ProcessorNotFound>("ProcessorNotFound")(
  {
    type: Schema.Literal(ProcessorNotFoundType),
    title: Schema.Literal("Not Found"),
    status: Schema.Literal(404),
    detail: Schema.String
  },
  { httpApiStatus: 404 }
) {
  static of(kind: string, id: string | undefined): ProcessorNotFound {
    return new ProcessorNotFound({
      type: ProcessorNotFoundType,
      title: "Not Found",
      status: 404,
      detail: id === undefined ? `No processors of kind "${kind}".` : `No processor "${id}" of kind "${kind}".`
    });
  }
}
const NotFoundProblem = ProcessorNotFound.pipe(HttpApiSchema.asJson({ contentType: "application/problem+json" }));

const target = { kind: Schema.String, id: Schema.String };

export const basePath = "/admin/processors";

// #region group
export const processorsGroup = HttpApiGroup.make("processors")
  .add(
    HttpApiEndpoint.get("listProcessors", basePath, {
      success: ProcessorList
    })
  )
  .add(
    HttpApiEndpoint.post("pauseProcessor", `${basePath}/:kind/:id/pause`, {
      params: target,
      success: ProcessorActionResult,
      error: NotFoundProblem
    })
  )
  .add(
    HttpApiEndpoint.post("resumeProcessor", `${basePath}/:kind/:id/resume`, {
      params: target,
      success: ProcessorActionResult,
      error: NotFoundProblem
    })
  )
  .add(
    HttpApiEndpoint.post("resetProcessor", `${basePath}/:kind/:id/reset`, {
      params: target,
      success: ProcessorActionResult,
      error: NotFoundProblem
    })
  )
  .middleware(ProcessorsAuthorization);
// #endregion group
