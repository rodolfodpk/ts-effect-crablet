import { Effect } from "effect";
import type { SqlError } from "@effect/sql/SqlError";
import type { StoredEvent } from "@crablet/eventstore";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import type { ConcurrencyException } from "@crablet/eventstore/DCBViolation";
import type { EventHandler } from "@crablet/event-poller/EventHandler";
import type { CommandHandler } from "@crablet/commands";
import type { AutomationHandler } from "../AutomationHandler.ts";

// Same withEventContext primer as ViewProjector.ts - duplicated locally rather than shared, same
// precedent as outbox/views never sharing code with each other.
const withEventContext = <A, E, R>(event: StoredEvent, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const withCausation = CorrelationContext.withCausationId(event.position)(effect);
  return event.correlationId !== null
    ? CorrelationContext.withCorrelationId(event.correlationId)(withCausation)
    : withCausation;
};

// A pre-built, R=never-discharged closure over CommandExecutor + its own ambient dependencies
// (EventStore/CommandAuditStore/SqlClient) - built once by AutomationsModule.ts's
// makeAutomationsProcessor (see that file's primer on why capturing the CommandExecutor tag value
// alone does not discharge its R), and threaded through here so this dispatcher itself never
// touches ambient services directly.
export type ExecuteDecision = <T, HE>(
  command: T,
  handler: CommandHandler<T, HE>
) => Effect.Effect<unknown, HE | ConcurrencyException | SqlError, never>;

// Port of internal.AutomationDispatcher.java: routes handle(automationName, events) to the
// registered AutomationHandler for that name; dies loudly on an unregistered automation (mirrors
// ViewEventHandler/OutboxEventHandler treating this as a misconfiguration, not a recoverable typed
// failure). For each event in the batch (in order): calls decide(event) to get a list of
// decisions, then executes each ExecuteCommand decision *sequentially, in returned order*, with
// the triggering event's causation/correlation propagated (matching Java's ScopedValue scope
// around CommandExecutor.execute - decide() itself runs outside that scope, since it only reads
// state and issues no writes of its own). The trigger event counts as processed once regardless of
// how many decisions it produced - the return value is `events.length`, not a decision tally,
// matching at-least-once redelivery semantics the same way ViewEventHandler/OutboxEventHandler do.
export const makeAutomationEventHandler = (
  // `AutomationHandler<any, any, any>` - see AutomationEventFetcher.ts's primer on why this
  // registry is type-erased at the internal-wiring boundary, never in the public API.
  handlers: ReadonlyArray<AutomationHandler<any, any, any>>,
  executeDecision: ExecuteDecision
): EventHandler<string, unknown, never> => {
  const byName = new Map(handlers.map((h) => [h.automationName, h] as const));

  const handle = (
    automationName: string,
    events: ReadonlyArray<StoredEvent>
  ): Effect.Effect<number, unknown, never> => {
    const automation = byName.get(automationName);
    if (!automation) return Effect.die(new Error(`Unknown automation: ${automationName}`));

    return Effect.gen(function* () {
      for (const event of events) {
        const decisions = yield* automation.decide(event);
        for (const decision of decisions) {
          if (decision._tag === "ExecuteCommand") {
            yield* withEventContext(event, executeDecision(decision.command, automation.handler));
          }
        }
      }
      return events.length;
    });
  };

  return { handle };
};
