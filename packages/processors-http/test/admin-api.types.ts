// Compile-time tests (never executed): the admin API is served fully typed (no cast in its registration).
import { Effect, type Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { EventStore } from "@crablet/eventstore";
import { adminApi } from "../src/AdminApi.ts";
import { adminApiLayer } from "../src/AdminApiLive.ts";
import type { ProcessorsAuthorization } from "../src/Authorization.ts";
import { processorsHandlers } from "../src/ProcessorsApiLive.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type RequirementsOf<L> = L extends Layer.Layer<infer _A, infer _E, infer R> ? R : never;
type AdminRequirements = RequirementsOf<ReturnType<typeof adminApiLayer>>;

// Beside the router's own platform services, the layer needs the EventStore (the event log) and an authorization, and the type says both: a server
// without an authorization does not compile (processors-api.test.ts).
export const needsTheEventStoreAndAnAuthorization: Equal<Extract<AdminRequirements, EventStore | ProcessorsAuthorization>, EventStore | ProcessorsAuthorization> =
  true;

// A handler registered against `adminApi` is checked against its endpoint.
const typed = processorsHandlers([]);
HttpApiBuilder.group(adminApi, "processors", (handlers) =>
  Effect.succeed(
    handlers
      // @ts-expect-error the list endpoint answers `{ processors }`, not `{ items }`
      .handle("listProcessors", () => Effect.succeed({ items: [] }))
      .handle("pauseProcessor", typed.pauseProcessor)
      .handle("resumeProcessor", typed.resumeProcessor)
      .handle("resetProcessor", typed.resetProcessor)
  )
);
