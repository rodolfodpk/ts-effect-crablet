import type { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { CommandHandler } from "@crablet/commands";
import * as EventSelectionNS from "@crablet/event-poller/EventSelection";
import type { EventSelection } from "@crablet/event-poller/EventSelection";
import type { ProcessorRuntimeOverrides } from "@crablet/event-poller/ProcessorRuntimeOverrides";
import type { AutomationDecision } from "./AutomationDecision.ts";

// Port of com.crablet.automations.AutomationHandler (+ AutomationDefinition it extends): combines
// EventSelection (what wakes this automation), ProcessorRuntimeOverrides (nullable per-automation
// polling/batch/backoff overrides) and the automation's own decide() logic in one interface -
// mirroring how ViewSubscription.ts combines the same two contracts, but keeping decide() here too
// since (unlike views, where matching-criteria and projection-logic are two separate Java beans)
// Java's AutomationHandler is already a single interface for both.
//
// `handler` is bound once per automation (see AutomationDecision.ts's primer on why - no runtime
// command-type lookup in this port), so one AutomationHandler reacts with exactly one command
// type `T`. A single automation that needs to emit more than one command type can still do so by
// modeling `T` as a union and supplying one union-capable CommandHandler<T, HE>.
//
// `E` is decide()'s own failure channel (e.g. reading state to decide from); `HE` is the bound
// command handler's failure channel - two independent channels, kept as separate type params
// rather than unioned up front, mirroring CommandExecutorService's own explicitness about generics.
export interface AutomationHandler<T, E = never, HE = never> extends EventSelection, ProcessorRuntimeOverrides {
  readonly automationName: string;
  // Exists purely to tag CommandMetrics (@crablet/metrics-otel) when this automation's decisions
  // are dispatched - TS commands are plain objects, not classes, so there's no
  // `command.getClass().getSimpleName()` equivalent to derive it from at the dispatch site.
  readonly commandType: string;
  readonly handler: CommandHandler<T, HE>;
  readonly decide: (event: StoredEvent) => Effect.Effect<ReadonlyArray<AutomationDecision<T>>, E, never>;
}

export const automationHandlerOf = <T, E = never, HE = never>(
  automationName: string,
  commandType: string,
  handler: CommandHandler<T, HE>,
  decide: (event: StoredEvent) => Effect.Effect<ReadonlyArray<AutomationDecision<T>>, E, never>,
  fields: Partial<EventSelection> & ProcessorRuntimeOverrides = {}
): AutomationHandler<T, E, HE> => ({
  automationName,
  commandType,
  handler,
  decide,
  ...EventSelectionNS.of(fields),
  pollingIntervalMs: fields.pollingIntervalMs,
  batchSize: fields.batchSize,
  backoffEnabled: fields.backoffEnabled,
  backoffThreshold: fields.backoffThreshold,
  backoffMultiplier: fields.backoffMultiplier,
  backoffMaxSeconds: fields.backoffMaxSeconds
});
