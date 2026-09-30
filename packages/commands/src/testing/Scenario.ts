import { Cause, Effect, Exit } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import type { Conflict, Duplicate } from "@crablet/eventstore/AppendErrors";
import { makeInMemoryEventStore, type InMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import type { Command } from "../Command.ts";
import { runHandler, withConflictRetry } from "../CommandExecutor.ts";
import type { InvalidInput } from "../Errors.ts";

// BDD-style tests of command logic with NO database:
//
//     const result = await given(Opened({ id: "c1" }), Incremented({ id: "c1", by: 5, opId: "a" }))
//       .when(Increment, { id: "c1", by: 3, opId: "b" });
//
//     expect(result.outcome).toBe("created");
//     expect(result.events.map((e) => e.type)).toEqual(["Incremented"]);
//
// The command runs through the REAL pipeline (input validation -> idempotency check -> prepare -> load
// -> decide -> conditional append, with conflict retry) against the in-memory store, whose append
// conditions and idempotency behave like Postgres (proved by the conformance suite). A `Given` is the
// history the store starts with; each `when` runs one command in an all-or-nothing transaction, and
// later `when`s see earlier ones' effects.
//
// What it cannot show is concurrency: nothing interleaves, so conflict retries never happen here. Test
// races against Postgres (see packages/commands/test/integration/command-run.test.ts).

export type ScenarioOutcome = "created" | "idempotent" | "failed";

export interface ScenarioResult<Err> {
  // "created": events were appended. "idempotent": the operation was already done (or decided nothing).
  // "failed": see `error`.
  readonly outcome: ScenarioOutcome;
  // Exactly the events this `when` appended (including any its `prepare` step appended); empty on failure.
  readonly events: ReadonlyArray<StoredEvent>;
  // The command's typed failure: a domain error from `decide`, `InvalidInput`, `Conflict` or `Duplicate`.
  readonly error: Err | InvalidInput | Conflict | Duplicate | undefined;
  // For an idempotent outcome, why nothing was appended.
  readonly reason: string | null;
}

export interface Scenario {
  readonly store: InMemoryEventStore;
  // The whole event log so far (the given events plus everything appended by earlier `when`s).
  readonly log: ReadonlyArray<StoredEvent>;
  // Run a command with raw (unvalidated) input, like a request arriving.
  readonly when: <In, Err>(command: Command<In, Err>, input: unknown) => Promise<ScenarioResult<Err>>;
}

export const given = (...events: ReadonlyArray<AppendEvent>): Scenario => {
  const store = makeInMemoryEventStore();
  store.seed(...events);

  const when: Scenario["when"] = async (command, rawInput) => {
    const before = store.log.length;
    const program = Effect.gen(function* () {
      const input = yield* command.decodeInput(rawInput);
      // One attempt = one transaction (exclusive, rolled back on failure); retried on Conflict like the
      // real executor, though in-memory a Conflict cannot occur.
      return yield* withConflictRetry(command.retries, store.transaction(runHandler(command.handler, input)));
    }).pipe(Effect.provide(store.layer));

    const exit = await Effect.runPromiseExit(program);
    if (Exit.isSuccess(exit)) {
      return {
        outcome: exit.value.wasIdempotent ? "idempotent" : "created",
        events: store.log.slice(before),
        error: undefined,
        reason: exit.value.reason
      };
    }
    const failure = exit.cause.reasons.find(Cause.isFailReason);
    // A defect (a bug in the command or the framework) must fail the test loudly, not become a result.
    if (failure === undefined) throw new Error(`command "${command.name}" died: ${Cause.pretty(exit.cause)}`);
    return { outcome: "failed", events: [], error: failure.error as never, reason: null };
  };

  return { store, get log() { return store.log; }, when };
};
