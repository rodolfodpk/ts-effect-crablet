import { processorConfigFrom, type ProcessorConfig } from "@crablet/event-poller/ProcessorConfig";
import type { AutomationsConfig } from "../AutomationsConfig.ts";
import type { AutomationHandler } from "../AutomationHandler.ts";

// One ProcessorConfig<string> per AutomationHandler: the defaults, the module's config, then the handler's own overrides - the same single-key shape
// ViewProcessorConfig.ts uses (not outbox's cross-join, since an automation has no secondary "publisher"-like dimension).
export const makeAutomationProcessorConfigs = (
  config: AutomationsConfig = {},
  // See AutomationEventFetcher.ts's primer on this registry's type erasure.
  handlers: ReadonlyArray<AutomationHandler<any, any, any>>
): ReadonlyArray<ProcessorConfig<string>> => handlers.map((handler) => processorConfigFrom(handler.automationName, config, handler));
