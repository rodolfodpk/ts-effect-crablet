import type { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { Command } from "@crablet/commands/Command";
import * as EventSelectionNS from "@crablet/event-poller/EventSelection";
import type { EventSelection } from "@crablet/event-poller/EventSelection";
import type { ProcessorRuntimeOverrides } from "@crablet/event-poller/ProcessorRuntimeOverrides";
import type { AutomationDecision } from "./AutomationDecision.ts";

// Combines EventSelection (what wakes this automation), ProcessorRuntimeOverrides (nullable
// per-automation polling/batch/backoff overrides) and the automation's own decide() logic in one
// interface - mirroring how ViewSubscription.ts combines the same two contracts.
//
// `command` is bound once per automation (see AutomationDecision.ts), so one AutomationHandler reacts
// with exactly one command. An automation that needs to issue more than one kind of command can
// model `T` as a union and bind a command whose input is that union.
//
// `E` is decide()'s own failure channel (e.g. reading state to decide from); `HE` is the bound
// command's failure channel - two independent channels, kept as separate type parameters.
export interface AutomationHandler<T, E = never, HE = never> extends EventSelection, ProcessorRuntimeOverrides {
  readonly automationName: string;
  // Exists purely to tag CommandMetrics (@crablet/metrics-otel) when this automation's decisions
  // are dispatched - TS commands are plain objects, not classes, so there's no
  // `command.getClass().getSimpleName()` equivalent to derive it from at the dispatch site.
  readonly command: Command<T, HE>;
  readonly decide: (event: StoredEvent) => Effect.Effect<ReadonlyArray<AutomationDecision<T>>, E, never>;
}

export const automationHandlerOf = <T, E = never, HE = never>(
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
