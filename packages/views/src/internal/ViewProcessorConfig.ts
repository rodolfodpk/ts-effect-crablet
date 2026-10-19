import { processorConfigFrom, type ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import type { ViewsConfig } from "../ViewsConfig.ts";
import type { ViewSubscription } from "../ViewSubscription.ts";

// One ProcessorConfig per view: the defaults, the module's config, then the view's own overrides (its subscription).
export const makeViewProcessorConfigs = (
  config: ViewsConfig = {},
  subscriptions: ReadonlyArray<ViewSubscription>
): ReadonlyArray<ProcessorConfig<string>> => {
  // A view with no `.on` would select nothing: refused, not run idle.
  const empty = subscriptions.filter((s) => s.eventTypes.size === 0).map((s) => `"${s.viewName}"`);
  if (empty.length > 0) throw new Error(`views: ${empty.join(", ")} ${empty.length === 1 ? "handles" : "handle"} no event; add .on(Event, ...)`);
  return subscriptions.map((subscription) => processorConfigFrom(subscription.viewName, config, subscription));
};
