import { Effect, Layer } from "effect";
import { makeLeaderSessions } from "./Leader.ts";
import { makeSharedListens } from "./SharedListen.ts";
import { ProcessConnections } from "./internal/ProcessConnectionsService.ts";

// THE CONNECTIONS A PROCESS HOLDS OUTSIDE THE POOL'S CHURN (ADR-0046): one lock session for every leader with the same client and options, and one
// LISTEN connection per client for every wake-up stream and the views' progress hub. They are a service built once per process, by `Crablet.layer`,
// and closed with that layer: the processors and the hub are built on it, so they release their locks and end their listens first, and then the
// connections close, before the pool does. Before ADR-0055 they lived in module-level WeakMaps, outside the layer graph.
export { ProcessConnections };

export const ProcessConnectionsLive: Layer.Layer<ProcessConnections> = Layer.effect(
  ProcessConnections,
  Effect.acquireRelease(
    Effect.sync(() => ({ leaders: makeLeaderSessions(), listens: makeSharedListens() })),
    (connections) => Effect.andThen(connections.leaders.close, connections.listens.close)
  )
);
