import * as EventSelectionNS from "@crablet/event-poller/EventSelection";
import type { EventSelection } from "@crablet/event-poller/EventSelection";
import type { ProcessorRuntimeOverrides } from "@crablet/event-poller/ProcessorRuntimeOverrides";

// Port of com.crablet.views.ViewSubscription: combines EventSelection (what to match) +
// ProcessorRuntimeOverrides (nullable per-view polling/batch/backoff overrides) + the view's name -
// the same "matching + overrides + identity" shape Java expresses via multiple interface extension.
export interface ViewSubscription extends EventSelection, ProcessorRuntimeOverrides {
  readonly viewName: string;
}

export const viewSubscriptionOf = (
  viewName: string,
  fields: Partial<EventSelection> & ProcessorRuntimeOverrides = {}
): ViewSubscription => ({
  viewName,
  ...EventSelectionNS.of(fields),
  pollingIntervalMs: fields.pollingIntervalMs,
  batchSize: fields.batchSize,
  backoffEnabled: fields.backoffEnabled,
  backoffThreshold: fields.backoffThreshold,
  backoffMultiplier: fields.backoffMultiplier,
  backoffMaxSeconds: fields.backoffMaxSeconds
});
