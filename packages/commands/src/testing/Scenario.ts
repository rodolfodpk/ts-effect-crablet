import { Cause, Clock, Effect, Exit } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import type { Conflict } from "@crablet/eventstore/AppendErrors";
import { makeInMemoryEventStore, type InMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import type * as Schema from "effect/Schema";
import type { Command, RawInput } from "../Command.ts";
import { runHandler, withConflictRetry } from "../CommandExecutor.ts";
import type { IdempotencyMismatch, InvalidInput } from "../Errors.ts";
import type { ExecutionResult } from "../ExecutionResult.ts";

// BDD-style tests of command logic with NO database:
//
//     const result = await given(Opened({ id: "c1" }), Incremented({ id: "c1", by: 5, opId: "a" }))
//       .when(Increment, { id: "c1", by: 3, opId: "b" });
//
//     expect(result.outcome).toBe("created");
//     expect(result.events.map((e) => e.type)).toEqual(["Incremented"]);
//
// The command runs through the REAL pipeline (input validation -> idempotency check -> resolve -> load
// -> decide -> conditional append, with conflict retry) against the in-memory store, whose append
// conditions and idempotency behave like Postgres (proved by the conformance suite). A `Given` is the
// history the store starts with; each `when` runs one command in an all-or-nothing transaction, and
// later `when`s see earlier ones' effects.
//
// An idempotent outcome rolls the `when` back, as the real executor does.
//
// What it cannot show is concurrency: nothing interleaves, so conflict retries never happen here. Test
// races against Postgres (see packages/commands/test/integration/command-run.test.ts).

class RolledBackIdempotent {
  readonly _tag = "RolledBackIdempotent";
  readonly result: ExecutionResult;
  constructor(result: ExecutionResult) {
    this.result = result;
  }
}

export type ScenarioOutcome = "created" | "idempotent" | "failed";

export interface ScenarioResult<Err> {
  // "created": events were appended. "idempotent": the operation was already done (or decided nothing).
  // "failed": see `error`.
  readonly outcome: ScenarioOutcome;
  // Exactly the events this `when` appended; empty on failure.
  readonly events: ReadonlyArray<StoredEvent>;
  // The command's typed failure: a domain error from `decide`, `InvalidInput`, `Conflict`, or `IdempotencyMismatch` (its key was used by a
  // different request).
  readonly error: Err | InvalidInput | Conflict | IdempotencyMismatch | undefined;
  // For an idempotent outcome, why nothing was appended.
  readonly reason: string | null;
}

export interface Scenario {
  readonly store: InMemoryEventStore;
  // The whole event log so far (the given events plus everything appended by earlier `when`s).
  readonly log: ReadonlyArray<StoredEvent>;
  // Run a command with its input before decoding, like a request arriving: typed from the command's schema, and validated as `run` does.
  readonly when: <In, Err, I extends Schema.Constraint>(command: Command<In, Err, I>, input: RawInput<I>) => Promise<ScenarioResult<Err>>;
  // The same scenario (same store, same log) with the clock fixed at `date`: what a model with a period reads as "now" (`.period`, Period.ts). Without it the real clock is used.
  readonly at: (date: Date) => Scenario;
}

// A clock that reads `ms` as the time and is otherwise the real one (sleeping, scheduling).
const fixedClock = (base: Clock.Clock, ms: number): Clock.Clock =>
  Object.assign(Object.create(base), {
    currentTimeMillisUnsafe: () => ms,
    currentTimeMillis: Effect.succeed(ms),
    currentTimeNanosUnsafe: () => BigInt(ms) * 1_000_000n,
    currentTimeNanos: Effect.succeed(BigInt(ms) * 1_000_000n)
  });

const scenarioOver = (store: InMemoryEventStore, atMs: number | null): Scenario => {
  const when: Scenario["when"] = async (command, rawInput) => {
    const before = store.log.length;
    const attempt = Effect.gen(function* () {
      const input = yield* command.decodeInput(rawInput);
      // One attempt = one transaction (exclusive, rolled back on failure); retried on Conflict like the
      // real executor, though in-memory a Conflict cannot occur.
      // An idempotent result rolls the attempt back, exactly like the real executor (CommandExecutor.ts); the result is carried out of the transaction.
      const attempt = store.transaction(
        Effect.flatMap(runHandler(command.handler, input), (result) => (result.wasIdempotent ? Effect.fail(new RolledBackIdempotent(result)) : Effect.succeed(result)))
      );
      return yield* withConflictRetry(command.retries, attempt).pipe(
        Effect.catch((error) => (error instanceof RolledBackIdempotent ? Effect.succeed(error.result) : Effect.fail(error)))
      );
    }).pipe(Effect.provide(store.layer));
    const program = atMs === null ? attempt : Effect.flatMap(Clock.Clock, (base) => Effect.provideService(attempt, Clock.Clock, fixedClock(base, atMs)));

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

  return { store, get log() { return store.log; }, when, at: (date) => scenarioOver(store, date.getTime()) };
};

export const given = (...events: ReadonlyArray<AppendEvent>): Scenario => {
  const store = makeInMemoryEventStore();
  store.seed(...events);
  return scenarioOver(store, null);
};

// Checks a command's answer to a repeat (ADR-0034): run the command, then run it again with the same input, as a client does when it lost the
// first answer. The first run must append (give it the `history` it needs); the second must append nothing and answer "already done" - not a second effect, and not an error for a request that succeeded. Works for both forms
// of `idempotentBy`. Throws, naming what is wrong, so a failed check fails the test in any runner.
export const assertRepeatHarmless = async <In, Err, I extends Schema.Constraint>(command: Command<In, Err, I>, input: RawInput<I>, history: ReadonlyArray<AppendEvent> = []): Promise<void> => {
  if (!command.idempotent) {
    throw new Error(`command "${command.name}" does not say how a repeat is recognised: declare idempotentBy (a query on a request id, or byModel())`);
  }
  const scenario = given(...history);
  const first = await scenario.when(command, input);
  if (first.outcome !== "created") {
    throw new Error(`command "${command.name}": the first run must append, but it ended ${first.outcome}${first.error !== undefined ? ` (${String(first.error)})` : ` (${first.reason})`}; give it the history it needs`);
  }
  const second = await scenario.when(command, input);
  if (second.events.length > 0) {
    throw new Error(`command "${command.name}": NOT HARMLESS - the repeat appended ${second.events.map((e) => e.type).join(", ")} again. Its idempotentBy does not recognise the repeat.`);
  }
  if (second.outcome !== "idempotent") {
    throw new Error(`command "${command.name}": the repeat of a request that succeeded failed (${String(second.error)}); a client retrying a lost answer would be told it failed. Answer a repeat with noop(...) in decide.`);
  }
};
