// Builds the runtime shape the processor runs (`AutomationHandler`) directly, with a hand-written `decide`, for tests of the dispatch itself
// (the event handler, the processor configs). An application builds it with `defineAutomation(...).on(...)`.
import type { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { Command } from "@crablet/commands/Command";
import * as EventSelectionNS from "@crablet/event-poller/EventSelection";
import type { EventSelection } from "@crablet/event-poller/EventSelection";
import type { ProcessorRuntimeOverrides } from "@crablet/event-poller/ProcessorRuntimeOverrides";
import type { AutomationDecision } from "../../src/AutomationDecision.ts";
import type { AutomationHandler } from "../../src/AutomationHandler.ts";

export const handlerOf = <T, E = never, HE = never>(
  automationName: string,
  command: Command<T, HE>,
  decide: (event: StoredEvent) => Effect.Effect<ReadonlyArray<AutomationDecision<T>>, E, never>,
  fields: Partial<EventSelection> & ProcessorRuntimeOverrides = {}
): AutomationHandler<T, E, HE> => ({
  automationName,
  command,
  decide,
  ...EventSelectionNS.of(fields),
  pollingIntervalMs: fields.pollingIntervalMs,
  batchSize: fields.batchSize,
  backoffEnabled: fields.backoffEnabled,
  backoffThreshold: fields.backoffThreshold,
  backoffMultiplier: fields.backoffMultiplier,
  backoffMaxSeconds: fields.backoffMaxSeconds
});
