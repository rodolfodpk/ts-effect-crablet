import { processorConfigFrom, type ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import type { ViewsConfig } from "../ViewsConfig.ts";
import type { ViewSubscription } from "../ViewSubscription.ts";

// One ProcessorConfig per view: the defaults, the module's config, then the view's own overrides (its subscription).
export const makeViewProcessorConfigs = (
  config: ViewsConfig = {},
  subscriptions: ReadonlyArray<ViewSubscription>
): ReadonlyArray<ProcessorConfig<string>> => subscriptions.map((subscription) => processorConfigFrom(subscription.viewName, config, subscription));
