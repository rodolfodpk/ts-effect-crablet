import * as EventSelectionNS from "@crablet/event-poller/EventSelection";
import type { EventSelection } from "@crablet/event-poller/EventSelection";
import type { ProcessorRuntimeOverrides } from "@crablet/event-poller/ProcessorRuntimeOverrides";

// Combines EventSelection (what to match) +
// ProcessorRuntimeOverrides (nullable per-view polling/batch/backoff overrides) + the view's name -.
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
