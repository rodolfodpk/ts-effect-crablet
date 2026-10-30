import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { ProcessorsAuthorization } from "./Authorization.ts";

// The event log API (ADR-0050): browse the events in the log, page by page, behind the same authorization as the processors (ProcessorsApi.ts). The
// description only: the handler is in EventsApiLive.ts. A page holds only events whose transaction had finished, so following `cursor` never skips one.
// A payload is shown only through the application's mask: the fields marked personal(...) redacted and the keys the definition does not know dropped;
// a type the application has no definition for shows no payload. Evolution rules as for the processors API: fields are added, never removed or retyped.

export const EventTag = Schema.Struct({ key: Schema.String, value: Schema.String }).annotate({ identifier: "EventTag" } as never);

export const LoggedEvent = Schema.Struct({
  eventId: Schema.String.annotate({ description: "The event's stable public id (a uuidv7). Not an order." } as never),
  type: Schema.String,
  tags: Schema.Array(EventTag),
  position: Schema.String.annotate({ description: "Its sequence position, as a string (a bigint). Events are ordered by (transactionId, position)." } as never),
  transactionId: Schema.String,
  occurredAt: Schema.String.annotate({ description: "When it was appended, ISO 8601." } as never),
  correlationId: Schema.NullOr(Schema.String),
  causationId: Schema.NullOr(Schema.String).annotate({ description: "The position of the event that caused it, if any." } as never),
  data: Schema.NullOr(Schema.Unknown).annotate({ description: "The payload as the application's mask shows it (personal fields redacted); null when withheld." } as never),
  dataShown: Schema.Boolean.annotate({ description: "False when the payload is withheld: no definition of this type was given to the API." } as never),
  metadata: Schema.NullOr(Schema.Unknown).annotate({
    description: "The client's metadata (ADR-0051) as the application's metadata mask shows it; null when the event has none or it is withheld."
  } as never),
  metadataShown: Schema.Boolean.annotate({ description: "False when the event has metadata the API does not show: no metadata mask was given." } as never)
}).annotate({ identifier: "LoggedEvent" } as never);
export type LoggedEvent = typeof LoggedEvent.Type;

export const EventPage = Schema.Struct({
  events: Schema.Array(LoggedEvent),
  cursor: Schema.String.annotate({ description: "Where the page stopped: pass it as `after` for the next page." } as never),
  more: Schema.Boolean.annotate({ description: "True when the page is full: read on from `cursor`. False: no more finished events now." } as never)
}).annotate({ identifier: "EventPage" } as never);
export type EventPage = typeof EventPage.Type;

export const EventsBadRequestType = "urn:crablet:problem:events-api:bad-request";

export class EventsBadRequest extends Schema.Class<EventsBadRequest>("EventsBadRequest")(
  {
    type: Schema.Literal(EventsBadRequestType),
    title: Schema.Literal("Bad Request"),
    status: Schema.Literal(400),
    detail: Schema.String
  },
  { httpApiStatus: 400 }
) {
  static of(detail: string): EventsBadRequest {
    return new EventsBadRequest({ type: EventsBadRequestType, title: "Bad Request", status: 400, detail });
  }
}
const BadRequestProblem = EventsBadRequest.pipe(HttpApiSchema.asJson({ contentType: "application/problem+json" }));

export const eventsPath = "/admin/events";
export const MAX_PAGE = 500;

// #region group
export const eventsGroup = HttpApiGroup.make("events")
  .add(
    HttpApiEndpoint.get("listEvents", eventsPath, {
      query: {
        types: Schema.optionalKey(Schema.String.annotate({ description: "Event types, comma-separated: an event of any of them." } as never)),
        tag: Schema.optionalKey(
          Schema.Union([Schema.String, Schema.Array(Schema.String)]).annotate({
            description: "A tag `key=value` (split at the first `=`), repeatable: an event carrying all of them. With neither `types` nor `tag`, every event."
          } as never)
        ),
        after: Schema.optionalKey(Schema.String.annotate({ description: "The `cursor` of the previous page." } as never)),
        limit: Schema.optionalKey(Schema.String.annotate({ description: `Events per page, 1 to ${MAX_PAGE} (default 100).` } as never))
      },
      success: EventPage,
      error: BadRequestProblem
    })
  )
  .middleware(ProcessorsAuthorization);
// #endregion group
