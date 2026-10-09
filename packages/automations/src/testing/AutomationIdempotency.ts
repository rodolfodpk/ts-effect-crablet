import { Cause, Effect, Exit } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import { makeInMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import { runHandler, withConflictRetry } from "@crablet/commands";
import type { Command } from "@crablet/commands/Command";
import type { AutomationHandler } from "../AutomationHandler.ts";

// A test of an automation's idempotency, for the automation's author to call. It runs the automation against an in-memory event store (no database), twice over
// the same trigger events, and says what is wrong, if anything. It never runs in production.
// (That the in-memory store gives the verdict a real database would is checked by test/integration/automation-idempotency-postgres.test.ts, which runs the same
// scenarios on both.)
//
// What it checks, and what it cannot:
//   - REPEAT: after the triggers have been handled once, handling them again (a crash between the commands and the cursor, a zombie leader) must append nothing.
//     This catches a command with no idempotentBy, or one whose query never matches (a tag misspelled, the wrong event type).
//   - DISTINCT: each trigger given must produce its own effect. A decision answered "already done" on the FIRST pass means its idempotentBy is too broad: it matched
//     something that is not this operation (the wallet's id, where the deposit's id was needed) and real work would be dropped in silence.
//   - It cannot know which triggers SHOULD share an effect: give it triggers that should each produce one. And what it checks is only as good as the triggers given:
//     two deposits to the same wallet expose a key on the wallet; two deposits to different wallets do not.

// Where the automation's commands run. The default is the in-memory event store. A backend over a real database exists so a test of the repository can check
// that both reach the same verdict (automation-idempotency-postgres.test.ts); an automation's author has no use for one.
export type BackendResult =
  | { readonly _tag: "done"; readonly wasIdempotent: boolean; readonly reason: string | null }
  | { readonly _tag: "failed"; readonly detail: string };

export interface IdempotencyBackend {
  // Appends the events, in order, and returns them as stored (with their positions).
  readonly seed: (events: ReadonlyArray<AppendEvent>) => Promise<ReadonlyArray<StoredEvent>>;
  // Runs one command the way the executor does, with the trigger's position as its causation.
  readonly execute: (command: Command<any, any>, input: unknown, causation: bigint) => Promise<BackendResult>;
  // How many events the log holds.
  readonly count: () => Promise<number>;
}

export interface IdempotencyOptions {
  // Events the commands need to find in the log (a wallet that was opened, a course that was defined). They are not triggers and are not handled.
  readonly given?: ReadonlyArray<AppendEvent>;
  readonly backend?: IdempotencyBackend;
}

export const inMemoryBackend = (): IdempotencyBackend => {
  const store = makeInMemoryEventStore();
  return {
    seed: async (events) => {
      const from = store.log.length;
      store.seed(...events);
      return store.log.slice(from);
    },
    execute: async (command, input, causation) => {
      const program = withConflictRetry(command.retries, store.transaction(runHandler(command.handler, input))).pipe(
        CorrelationContext.withCausationId(causation),
        Effect.provide(store.layer)
      );
      const exit = await Effect.runPromiseExit(program);
      if (Exit.isSuccess(exit)) return { _tag: "done", wasIdempotent: exit.value.wasIdempotent, reason: exit.value.reason };
      const failure = exit.cause.reasons.find(Cause.isFailReason);
      return { _tag: "failed", detail: failure === undefined ? Cause.pretty(exit.cause) : JSON.stringify(failure.error) };
    },
    count: async () => store.log.length
  };
};

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
  const backend = options.backend ?? inMemoryBackend();
  await backend.seed(options.given ?? []);
  const stored = await backend.seed(triggers);

  const handleOnce = async (): Promise<ReadonlyArray<Outcome>> => {
    const outcomes: Array<Outcome> = [];
    for (const event of stored) {
      const decisions = await Effect.runPromise(automation.decide(event));
      for (const decision of decisions) {
        if (decision._tag !== "ExecuteCommand") continue;
        const result = await backend.execute(automation.command, decision.input, event.position);
        if (result._tag === "done") {
          outcomes.push({
            trigger: event.position,
            command: automation.command.name,
            result: result.wasIdempotent ? (result.reason === "DUPLICATE_OPERATION" ? "already-done" : "noop") : "created",
            detail: result.reason ?? ""
          });
        } else {
          outcomes.push({ trigger: event.position, command: automation.command.name, result: "failed", detail: result.detail });
        }
      }
    }
    return outcomes;
  };

  const problems: Array<string> = [];
  const before = await backend.count();
  const first = await handleOnce();
  const afterFirst = await backend.count();
  const effects = afterFirst - before;

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

  await handleOnce();
  const repeated = (await backend.count()) - afterFirst;
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
