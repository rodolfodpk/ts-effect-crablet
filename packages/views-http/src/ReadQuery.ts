import * as Schema from "effect/Schema";
import { HttpApiSchema } from "effect/http-api";
import { BadRequestProblem } from "@crablet/commands-http";
import { ViewsUnavailableProblem } from "./ReadProblems.ts";

// The consistency parameters of a read, to spread into an endpoint's `query`. Plain strings on purpose: the wrapper validates them, so a bad
// value answers with the same problem body as every other 400 instead of the HTTP framework's empty-bodied default.
export const consistencyQuery = {
  consistentWith: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'Read at least as fresh as a write: the `marker` a command returned (`"<transactionId>:<position>"`), or `latest` for everything committed when the request arrived. Waits for the views this read uses.'
    } as never)
  ),
  consistency: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "What to do if a view has not caught up in time: `strict` fails with 503, `bounded` answers anyway with the header `Crablet-Consistency: stale`, `eventual` does not wait. A request may ask for a stricter mode than the endpoint's, and a looser one only where the server allows it."
    } as never)
  ),
  waitTimeout: Schema.optionalKey(
    Schema.String.annotate({ description: "How long to wait for the views, in milliseconds (a whole number from 1 up to the endpoint's maximum)." } as never)
  )
};

// The success schema of a read: the body, plus the optional header that marks it stale (only a `bounded` read ever sets it). The handler
// the wrapper builds returns `HttpApiSchema.withHeaders({ body, headers })`, and a client resolves it to `{ body, headers }`.
export const ReadSuccess = <S extends Schema.Top>(body: S) =>
  HttpApiSchema.WithHeaders(body, { "crablet-consistency": Schema.optionalKey(Schema.Literal("stale")) });

// What a wrapped read can answer besides its own errors: a 400 for a bad parameter or a marker beyond the log, a 503 when the views are behind.
// Spread into the endpoint's `error` list: `error: [MyNotFound, ...readProblems]`.
export const readProblems = [BadRequestProblem, ViewsUnavailableProblem] as const;
