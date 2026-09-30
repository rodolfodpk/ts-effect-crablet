import { Effect, Metric } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventHandler } from "@crablet/event-poller/EventHandler";
import * as ViewMetrics from "@crablet/metrics-otel/ViewMetrics";
import type { ViewProjector } from "../ViewProjector.ts";

// Routes handle(viewName, events) to the registered ViewProjector for that name; dies loudly on an
// unregistered view (a programmer error, not a recoverable typed failure).
export const makeViewEventHandler = (projectors: ReadonlyArray<ViewProjector>): EventHandler<string, unknown, never> => {
  const byName = new Map(projectors.map((p) => [p.viewName, p] as const));

  const handle = (viewName: string, events: ReadonlyArray<StoredEvent>): Effect.Effect<number, unknown, never> => {
    const projector = byName.get(viewName);
    if (!projector) return Effect.die(new Error(`Unknown view: ${viewName}`));

    return ViewMetrics.observe(
      ViewMetrics.project,
      projector.handle(events).pipe(
        Effect.tap((handled) => Metric.update(Metric.withAttributes(ViewMetrics.eventsProjected, { view: viewName }), handled))
      ),
      [["view", viewName]]
    );
  };

  return { handle };
};
