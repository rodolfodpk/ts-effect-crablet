import { Cause, Clock, DateTime, Effect, Exit } from "effect";
import { EventStore, type StoredEvent } from "@crablet/eventstore";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import type { Conflict } from "@crablet/eventstore/AppendErrors";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import { makeInMemoryEventStore, type InMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import type * as Schema from "effect/Schema";
import type { Command, RawInput } from "../Command.ts";
import { runHandler, withConflictRetry } from "../CommandExecutor.ts";
import { checkDeadlineCommands, DeadlineFired, DeadlineScheduled, outcomeOfFailure, outcomeOfResult, type FiredDeadline } from "../Deadline.ts";
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
  // The same scenario (same store, same log) with the clock fixed at `now`: what `decide` gets as `now`, and what a model with a period reads (`.period`, Period.ts).
  // Without it the real clock is used.
  readonly at: (now: DateTime.Utc) => Scenario;
  // Fire the deadlines due at the scenario's clock (`at`), as the deadlines processor does (ADR-0043): each set by an earlier `when` (or given) and not
  // fired yet, oldest due first, runs its command under the deadline as its cause, and its firing is recorded (`crablet.DeadlineFired`). `commands` are
  // the ones the processor would be given, checked as it checks them. A deadline whose command is not among them, or whose command fails with
  // something other than a domain error, throws.
  readonly fireDue: (...commands: ReadonlyArray<Command<any, any>>) => Promise<ReadonlyArray<FiredDeadline>>;
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
  // Under the scenario's clock, when it has one.
  const atClock = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    atMs === null ? effect : Effect.flatMap(Clock.Clock, (base) => Effect.provideService(effect, Clock.Clock, fixedClock(base, atMs)));

  // One command run, as `when` does it; under `cause` (a deadline's position) when one is given, as an automation or the deadlines processor runs it.
  // With the executor's result, when there is one: its marker is what a firing records.
  const run = async <In, Err>(
    command: Command<In, Err, any>,
    decodeInput: Effect.Effect<In, InvalidInput>,
    cause: bigint | null
  ): Promise<{ readonly result: ScenarioResult<Err>; readonly executed: ExecutionResult | undefined }> => {
    const before = store.log.length;
    const attempt = Effect.gen(function* () {
      const input = yield* decodeInput;
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
    const program = atClock(cause === null ? attempt : CorrelationContext.withCausationId(cause)(attempt));

    const exit = await Effect.runPromiseExit(program);
    if (Exit.isSuccess(exit)) {
      const result: ScenarioResult<Err> = {
        outcome: exit.value.wasIdempotent ? "idempotent" : "created",
        events: store.log.slice(before),
        error: undefined,
        reason: exit.value.reason
      };
      return { result, executed: exit.value };
    }
    const failure = exit.cause.reasons.find(Cause.isFailReason);
    // A defect (a bug in the command or the framework) must fail the test loudly, not become a result.
    if (failure === undefined) throw new Error(`command "${command.name}" died: ${Cause.pretty(exit.cause)}`);
    return { result: { outcome: "failed", events: [], error: failure.error as never, reason: null }, executed: undefined };
  };

  const when: Scenario["when"] = async (command, rawInput) => (await run(command, command.decodeInput(rawInput), null)).result;

  const fireDue: Scenario["fireDue"] = async (...commands) => {
    const byName = checkDeadlineCommands(commands);
    const now = atMs ?? Date.now();
    // Pending: scheduled and not fired, the rule the processor's table is rebuilt by (a firing is caused by its deadline).
    const fired = new Set(store.log.filter((e) => e.type === DeadlineFired.type).map((e) => e.causationId));
    const due = store.log
      .filter((e) => e.type === DeadlineScheduled.type && !fired.has(e.position))
      .map((event) => ({ event, scheduled: DeadlineScheduled.decode(event.data) }))
      .filter(({ scheduled }) => DateTime.toEpochMillis(scheduled.dueAt) <= now)
      .sort((a, b) => DateTime.toEpochMillis(a.scheduled.dueAt) - DateTime.toEpochMillis(b.scheduled.dueAt) || Number(a.event.position - b.event.position));

    const results: Array<FiredDeadline> = [];
    for (const { event, scheduled } of due) {
      const command = byName.get(scheduled.command);
      if (command === undefined) throw new Error(`deadline at position ${event.position}: command "${scheduled.command}" is not among the commands given to fireDue`);
      const { result, executed } = await run(command, command.decodeInput(scheduled.input), event.position);
      const outcome = executed !== undefined ? outcomeOfResult(executed) : outcomeOfFailure(result.error);
      if (outcome === undefined) throw new Error(`deadline at position ${event.position}: command "${command.name}" failed with a fault, not a decision: ${String(result.error)}`);
      const record = Effect.flatMap(EventStore, (eventStore) =>
        eventStore.append([DeadlineFired({ deadlinePosition: event.position.toString(), ...outcome })])
      );
      await Effect.runPromise(atClock(CorrelationContext.withCausationId(event.position)(record).pipe(Effect.provide(store.layer))));
      results.push({ deadlinePosition: event.position, command: command.name, ...outcome, events: result.events });
    }
    return results;
  };

  return { store, get log() { return store.log; }, when, at: (now) => scenarioOver(store, DateTime.toEpochMillis(now)), fireDue };
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
