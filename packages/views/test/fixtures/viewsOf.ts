// Pairs hand-built projectors and subscriptions, by view name, into what the processor takes, for tests of the processor itself. An application
// passes the views `defineView(...).on(...)` builds.
import { Effect } from "effect";
import type { RunnableView } from "../../src/ViewsModule.ts";
import type { ViewProjector } from "../../src/ViewProjector.ts";
import type { ViewSubscription } from "../../src/ViewSubscription.ts";

export const viewsOf = (projectors: ReadonlyArray<ViewProjector<any>>, subscriptions: ReadonlyArray<ViewSubscription>): ReadonlyArray<RunnableView> =>
  subscriptions.map((subscription) => {
    const projector = projectors.find((p) => p.viewName === subscription.viewName);
    if (projector === undefined) throw new Error(`viewsOf: no projector for "${subscription.viewName}"`);
    return { name: subscription.viewName, projector: Effect.succeed(projector), subscription: () => subscription };
  });
