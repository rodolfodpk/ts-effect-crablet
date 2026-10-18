import { processorConfigFrom, type ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import type { AutomationsConfig } from "../AutomationsConfig.ts";
import type { AutomationHandler } from "../AutomationHandler.ts";

// One ProcessorConfig<string> per AutomationHandler: the defaults, the module's config, then the handler's own overrides - the same single-key shape
// ViewProcessorConfig.ts uses (not outbox's cross-join, since an automation has no secondary "publisher"-like dimension).
export const makeAutomationProcessorConfigs = (
  config: AutomationsConfig = {},
  // See AutomationsDeps.automations (AutomationsModule.ts) on this registry's type erasure.
  handlers: ReadonlyArray<AutomationHandler<any, any, any>>
): ReadonlyArray<ProcessorConfig<string>> => {
  // An automation with no `.on` would select nothing: refused, not run idle.
  const empty = handlers.filter((h) => h.eventTypes.size === 0).map((h) => `"${h.automationName}"`);
  if (empty.length > 0) throw new Error(`automations: ${empty.join(", ")} ${empty.length === 1 ? "handles" : "handle"} no event; add .on(Event, ...)`);
  return handlers.map((handler) => processorConfigFrom(handler.automationName, config, handler));
};
