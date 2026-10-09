import { Cause, Effect, Exit } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import { makeInMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import { runHandler, withConflictRetry } from "@crablet/commands";
import type { AutomationHandler } from "../AutomationHandler.ts";

// A test of an automation's idempotency, for the automation's author to call. It runs the automation against an in-memory event store (no database), twice over
// the same trigger events, and says what is wrong, if anything. It never runs in production.
//
// What it checks, and what it cannot:
//   - REPEAT: after the triggers have been handled once, handling them again (a crash between the commands and the cursor, a zombie leader) must append nothing.
//     This catches a command with no idempotentBy, or one whose query never matches (a tag misspelled, the wrong event type).
//   - DISTINCT: each trigger given must produce its own effect. A decision answered "already done" on the FIRST pass means its idempotentBy is too broad: it matched
//     something that is not this operation (the wallet's id, where the deposit's id was needed) and real work would be dropped in silence.
//   - It cannot know which triggers SHOULD share an effect: give it triggers that should each produce one. And what it checks is only as good as the triggers given:
//     two deposits to the same wallet expose a key on the wallet; two deposits to different wallets do not.

export interface IdempotencyOptions {
  // Events the commands need to find in the log (a wallet that was opened, a course that was defined). They are not triggers and are not handled.
  readonly given?: ReadonlyArray<AppendEvent>;
}

export interface IdempotencyReport {
  readonly ok: boolean;
  readonly problems: ReadonlyArray<string>;
  // Events the first pass appended: what the triggers produced.
  readonly effects: number;
}

interface Outcome {
  readonly trigger: bigint;
  readonly command: string;
  readonly result: "created" | "already-done" | "noop" | "failed";
  readonly detail: string;
}

export const checkAutomationIdempotency = async (
  automation: AutomationHandler<any, any, any>,
  triggers: ReadonlyArray<AppendEvent>,
  options: IdempotencyOptions = {}
): Promise<IdempotencyReport> => {
  const store = makeInMemoryEventStore();
  store.seed(...(options.given ?? []));
  const firstTrigger = store.log.length;
  store.seed(...triggers);
  const stored: ReadonlyArray<StoredEvent> = store.log.slice(firstTrigger);

  const handleOnce = async (): Promise<ReadonlyArray<Outcome>> => {
    const outcomes: Array<Outcome> = [];
    for (const event of stored) {
      const decisions = await Effect.runPromise(automation.decide(event));
      for (const decision of decisions) {
        if (decision._tag !== "ExecuteCommand") continue;
        const program = withConflictRetry(
          automation.command.retries,
          store.transaction(runHandler(automation.command.handler, decision.input))
        ).pipe(CorrelationContext.withCausationId(event.position), Effect.provide(store.layer));
        const exit = await Effect.runPromiseExit(program);
        if (Exit.isSuccess(exit)) {
          const result = exit.value.wasIdempotent ? (exit.value.reason === "DUPLICATE_OPERATION" ? "already-done" : "noop") : "created";
          outcomes.push({ trigger: event.position, command: automation.command.name, result, detail: exit.value.reason ?? "" });
        } else {
          const failure = exit.cause.reasons.find(Cause.isFailReason);
          outcomes.push({
            trigger: event.position,
            command: automation.command.name,
            result: "failed",
            detail: failure === undefined ? Cause.pretty(exit.cause) : JSON.stringify(failure.error)
          });
        }
      }
    }
    return outcomes;
  };

  const problems: Array<string> = [];
  const before = store.log.length;
  const first = await handleOnce();
  const effects = store.log.length - before;

  for (const o of first) {
    if (o.result === "failed") {
      problems.push(`FAILED: "${o.command}" for the trigger at position ${o.trigger} failed (${o.detail}); the test cannot say anything about it. Give it the events it needs with { given }.`);
    } else if (o.result === "already-done") {
      problems.push(
        `TOO BROAD: "${o.command}" for the trigger at position ${o.trigger} was answered "already done" on the FIRST pass. Its idempotentBy matches something that is not this operation, ` +
          `so real work would be dropped in silence. Put what tells this trigger apart (its own id, the target, the attempt) in the query.`
      );
    }
  }

  const afterFirst = store.log.length;
  await handleOnce();
  const repeated = store.log.length - afterFirst;
  if (repeated > 0) {
    problems.push(
      `NOT IDEMPOTENT: handling the same triggers a second time appended ${repeated} more event(s). "${automation.command.name}" must declare an idempotentBy ` +
        `whose query matches the event it appends (same type, same tags), or a redelivered batch does its work twice.`
    );
  }

  return { ok: problems.length === 0, problems, effects };
};

// Throws, listing every problem, so a failed check fails the test in any runner.
export const assertAutomationIdempotent = async (
  automation: AutomationHandler<any, any, any>,
  triggers: ReadonlyArray<AppendEvent>,
  options: IdempotencyOptions = {}
): Promise<IdempotencyReport> => {
  const report = await checkAutomationIdempotency(automation, triggers, options);
  if (!report.ok) throw new Error(`automation "${automation.automationName}" is not idempotent:\n  - ${report.problems.join("\n  - ")}`);
  return report;
};
