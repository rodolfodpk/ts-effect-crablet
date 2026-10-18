import { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { Command } from "@crablet/commands/Command";
import * as EventSelectionNS from "@crablet/event-poller/EventSelection";
import type { EventSelection } from "@crablet/event-poller/EventSelection";
import type { ProcessorRuntimeOverrides } from "@crablet/event-poller/ProcessorRuntimeOverrides";
import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import { executeCommand, type AutomationDecision } from "./AutomationDecision.ts";

// What the automations processor runs: `defineAutomation(...).on(...)` builds it. It combines EventSelection (what wakes the automation),
// ProcessorRuntimeOverrides (per-automation polling/batch/backoff, given to the processor by name) and `decide`, which turns one event into the
// decisions to run.
//
// `command` is bound once per automation, so one automation reacts with exactly one command. An automation that needs to issue more than one
// kind of command can bind a command whose input is a union.
//
// `E` is decide()'s own failure channel (an event that cannot be decoded); `HE` is the bound command's failure channel - two independent
// channels, kept as separate type parameters.
export interface AutomationHandler<T, E = never, HE = never> extends EventSelection, ProcessorRuntimeOverrides {
  readonly automationName: string;
  // Exists purely to tag CommandMetrics (@crablet/metrics-otel) when this automation's decisions
  // are dispatched - TS commands are plain objects, not classes, so there's no
  // `command.getClass().getSimpleName()` equivalent to derive it from at the dispatch site.
  readonly command: Command<T, HE>;
  readonly decide: (event: StoredEvent) => Effect.Effect<ReadonlyArray<AutomationDecision<T>>, E, never>;
}

// What an automation needs of an event definition (`defineEvent`'s result satisfies it): typed structurally, as a view's is.
export interface AutomationEvent<Data> {
  readonly type: string;
  readonly decodeStored: (event: Pick<StoredEvent, "data" | "position" | "transactionId">) => Effect.Effect<Data, EventDecodingError>;
}

export interface AutomationContext {
  readonly event: StoredEvent;
  readonly position: bigint;
  // The value of a tag the event carries, if any.
  readonly tag: (key: string) => string | undefined;
}

// What a handler asks for: one request (the command's input), several, or none.
export type Requests<T> = T | ReadonlyArray<T> | undefined;

// What the automation reads besides its event types (a tag every event must carry, ...). The event types come from `.on`.
export type AutomationSelection = Partial<Omit<EventSelection, "eventTypes">>;

export interface DefinedAutomation<T, HE> extends AutomationHandler<T, EventDecodingError, HE> {
  // The event types a handler was declared for: what the automation selects.
  readonly handles: ReadonlyArray<string>;
  on<Data>(event: AutomationEvent<Data>, handle: (data: Data, ctx: AutomationContext) => Requests<T>): DefinedAutomation<T, HE>;
}

type Handler = {
  readonly decode: AutomationEvent<unknown>["decodeStored"];
  readonly handle: (data: unknown, ctx: AutomationContext) => Requests<unknown>;
};

// An automation: when one of its events is appended, run its command with the input the handler builds from the event.
//
//     export const WelcomeOnOpen = defineAutomation("wallet-opened-welcome-notification", SendWelcomeNotification)
//       .on(WalletOpened, (d) => ({ walletId: d.walletId, owner: d.owner }));
//
// A handler is pure: it maps the event to the command's input. A decision that needs state belongs in the command (`resolve`, `model`), where it is
// consistent; an input built from the trigger also makes a redelivery the same request (ADR-0035). Each event is decoded with its own definition, and
// one that cannot be decoded fails the batch, never skipped (ADR-0017). Polling and batch overrides are given to the processor, by name.
export const defineAutomation = <T, HE = never>(
  automationName: string,
  command: Command<T, HE>,
  selection: AutomationSelection = {}
): DefinedAutomation<T, HE> => {
  // An automation runs at least once, not exactly once: its batch is handled again after a crash between the command and the cursor, or by a
  // zombie leader and its successor. A command without `idempotentBy` would then do its work twice, so it is refused when the automation is defined.
  if (!command.idempotent) {
    throw new Error(
      `automation "${automationName}": command "${command.name}" has no idempotentBy. An automation can run the same batch twice, so its command must say how to tell that the work is already done.`
    );
  }
  return build(automationName, command, selection, new Map());
};

const build = <T, HE>(
  automationName: string,
  command: Command<T, HE>,
  selection: AutomationSelection,
  handlers: ReadonlyMap<string, Handler>
): DefinedAutomation<T, HE> => {
  const handles = [...handlers.keys()];
  return {
    automationName,
    command,
    handles,
    decide: (event) => {
      const handler = handlers.get(event.type);
      if (handler === undefined) return Effect.succeed([]);
      return Effect.map(handler.decode(event), (data) => {
        const requests = handler.handle(data, { event, position: event.position, tag: (key) => event.tags.find((t) => t.key === key)?.value });
        const inputs = requests === undefined ? [] : Array.isArray(requests) ? requests : [requests];
        return inputs.map((input) => executeCommand(input as T));
      });
    },
    on: (event, handle) => {
      if (handlers.has(event.type)) throw new Error(`automation "${automationName}": a handler for ${event.type} is already declared`);
      return build(automationName, command, selection, new Map([...handlers, [event.type, { decode: event.decodeStored as Handler["decode"], handle: handle as Handler["handle"] }]]));
    },
    ...EventSelectionNS.of({ ...selection, eventTypes: new Set(handles) }),
    pollingIntervalMs: undefined,
    batchSize: undefined,
    backoffEnabled: undefined,
    backoffThreshold: undefined,
    backoffMultiplier: undefined,
    backoffMaxSeconds: undefined
  };
};
