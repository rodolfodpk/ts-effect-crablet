import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { EventStore } from "@crablet/eventstore";
import { adminApi } from "./AdminApi.ts";
import { eventsHandler, type Masks } from "./EventsApiLive.ts";
import { processorsHandlers, type ProcessorSource } from "./ProcessorsApiLive.ts";

export interface AdminApiOptions {
  // One per module: `{ kind, service, describe? }` (ProcessorsApiLive.ts). Two of the same kind are refused when the layer is built.
  readonly sources: ReadonlyArray<ProcessorSource>;
  // What of an event's payload and metadata the event log shows (EventsApiLive.ts); without them, payloads are shown and metadata is withheld.
  readonly masks?: Masks | undefined;
}

// The admin API served: both groups registered against `adminApi`, every type checked (no cast: the API is concrete). The layer needs the EventStore
// (for the event log). The server also needs `ProcessorsAuthorization` (provide `authorizationFrom(...)`, Authorization.ts, or your own) or it fails to
// start; the layer's type does not say so, because the middleware is resolved when the server starts.
export const adminApiLayer = (options: AdminApiOptions) => {
  const processors = processorsHandlers(options.sources);
  const events = eventsHandler(options.masks);
  return HttpApiBuilder.layer(adminApi).pipe(
    Layer.provide(
      HttpApiBuilder.group(adminApi, "processors", (handlers) =>
        Effect.succeed(
          handlers
            .handle("listProcessors", processors.listProcessors)
            .handle("pauseProcessor", processors.pauseProcessor)
            .handle("resumeProcessor", processors.resumeProcessor)
            .handle("resetProcessor", processors.resetProcessor)
        )
      )
    ),
    // The event log reads the EventStore. It is taken when the group is built and given to each request (ADR-0042), so it is a requirement of this
    // layer, met once, and not of every request.
    Layer.provide(
      HttpApiBuilder.group(adminApi, "events", (handlers) =>
        Effect.map(Effect.context<EventStore>(), (services) =>
          handlers.handle("listEvents", (request) => events(request).pipe(Effect.provideContext(services)))
        )
      )
    )
  );
};
