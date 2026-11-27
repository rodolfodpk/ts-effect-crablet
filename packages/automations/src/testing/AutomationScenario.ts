import { Cause, Effect, Exit, type DateTime } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import { given as givenHistory, type Scenario, type ScenarioResult } from "@crablet/commands/testing/Scenario";
import type { AutomationHandler } from "../AutomationHandler.ts";

// A spec of an automation with NO database and no poller: given the log, when its trigger events are appended, then what it asks for and what its
// command did.
//
//     const s = automationScenario(WelcomeOnOpen).given();
//     const result = await s.when(WalletOpened({ walletId: "w1", owner: "ann", initialBalance: 0 }));
//
//     expect(result.inputs).toEqual([{ walletId: "w1", owner: "ann" }]);        // what the automation asked its command for
//     expect(result.events.map((e) => e.type)).toEqual(["WelcomeNotificationSent"]); // what the command appended
//     expect((await s.redeliver()).events).toEqual([]);                          // the same triggers again: nothing more (at least once)
//
// Each trigger is appended to the in-memory log, then handed to the automation's `decide` as the processor hands it a stored event, and each input it
// asks for runs its command through the real pipeline (Scenario's `whenDecoded`: idempotency, model, decide, conditional append) under the trigger's
// position as its cause, as the processor runs it (ADR-0035's backstop sees that cause). Later `when`s see the effects of earlier ones.
//
// What it does not show: the poller (which events wake the automation, in which batches, the cursor) and races. The selection is the automation's
// `handles`; an event of another type asks for nothing here, as there. `assertAutomationIdempotent` (./AutomationIdempotency) checks the key across
// many triggers.

// One command the automation ran: for which trigger, with which input, and the command's result (outcome, events appended, error).
export interface AutomationRun<T, HE> {
  readonly trigger: StoredEvent;
  readonly input: T;
  readonly result: ScenarioResult<HE>;
}

export interface AutomationScenarioResult<T, HE> {
  // What the automation asked its command for, in order: every trigger's inputs.
  readonly inputs: ReadonlyArray<T>;
  readonly runs: ReadonlyArray<AutomationRun<T, HE>>;
  // Every event the runs appended, in order.
  readonly events: ReadonlyArray<StoredEvent>;
}

export interface AutomationScenario<T, HE> {
  // The commands' scenario underneath: the log, a command run by hand (`when`), the clock (`at` on `automationScenario(...).given(...)`).
  readonly scenario: Scenario;
  // Append the triggers and let the automation handle each, in order.
  readonly when: (...triggers: ReadonlyArray<AppendEvent>) => Promise<AutomationScenarioResult<T, HE>>;
  // Hand the automation the triggers of the last `when` again, as stored (same positions): a redelivery after a crash between its commands and its
  // cursor, or by a zombie leader. An idempotent automation appends nothing more.
  readonly redeliver: () => Promise<AutomationScenarioResult<T, HE>>;
}

const over = <T, E, HE>(automation: AutomationHandler<T, E, HE>, scenario: Scenario): AutomationScenario<T, HE> => {
  let last: ReadonlyArray<StoredEvent> = [];

  const handle = async (triggers: ReadonlyArray<StoredEvent>): Promise<AutomationScenarioResult<T, HE>> => {
    const inputs: Array<T> = [];
    const runs: Array<AutomationRun<T, HE>> = [];
    for (const trigger of triggers) {
      const decided = await Effect.runPromiseExit(automation.decide(trigger));
      // A trigger the automation cannot decode fails its batch in production (ADR-0017): here it fails the spec, naming the event.
      if (Exit.isFailure(decided)) {
        throw new Error(`automation "${automation.automationName}" failed on ${trigger.type} at position ${trigger.position}: ${Cause.pretty(decided.cause)}`);
      }
      for (const decision of decided.value) {
        if (decision._tag !== "ExecuteCommand") continue;
        inputs.push(decision.input);
        runs.push({ trigger, input: decision.input, result: await scenario.whenDecoded(automation.command, decision.input, { cause: trigger.position }) });
      }
    }
    return { inputs, runs, events: runs.flatMap((r) => r.result.events) };
  };

  return {
    scenario,
    when: (...triggers) => {
      const from = scenario.log.length;
      scenario.store.seed(...triggers);
      last = scenario.log.slice(from);
      return handle(last);
    },
    redeliver: () => handle(last)
  };
};

export interface AutomationGiven<T, HE> {
  // The log the automation's command finds (a wallet opened, a course defined). These events are not triggers: the automation does not handle them.
  readonly given: (...history: ReadonlyArray<AppendEvent>) => AutomationScenario<T, HE> & {
    // The same, with the clock fixed at `now` (what the command's `decide` gets as `now`).
    readonly at: (now: DateTime.Utc) => AutomationScenario<T, HE>;
  };
}

export const automationScenario = <T, E, HE>(automation: AutomationHandler<T, E, HE>): AutomationGiven<T, HE> => ({
  given: (...history) => {
    const scenario = givenHistory(...history);
    return { ...over(automation, scenario), at: (now) => over(automation, scenario.at(now)) };
  }
});
