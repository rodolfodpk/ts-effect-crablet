import { Effect } from "effect";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import { EventStore, type EventStoreService } from "@crablet/eventstore";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import { Duplicate } from "@crablet/eventstore/AppendErrors";
import * as LogPositionNS from "@crablet/eventstore/LogPosition";
import * as Query from "@crablet/eventstore/Query";
import type { Query as QueryType } from "@crablet/eventstore/Query";
import * as CD from "./CommandDecision.ts";
import type { CommandHandler } from "./CommandExecutor.ts";
import { InvalidInput, inputIssuesOf, type AnyDomainErrorClass, type KindedError } from "./Errors.ts";
import type { ModelInstance } from "./Model.ts";

// A command is one declaration of "what happens when this request arrives":
//
//     export const Deposit = defineCommand({
//       name: "deposit",
//       input: Schema.Struct({ walletId: Schema.String, depositId: Schema.String, amount: Schema.Positive }),
//       model: (c) => WalletModel.of({ id: c.walletId, ...period }),           // state + boundary
//       consistency: () => concurrent({ guard: WalletModel.lifecycleQuery(...) }), // optional; default strict()
//       idempotentBy: (c) => DepositMade.where({ deposit_id: c.depositId }),   // optional
//       decide: (wallet, c) =>
//         wallet.exists ? emit(DepositMade({ ... })) : fail(new WalletNotFound({ walletId: c.walletId }))
//     });
//
// `decide` is PURE: no Effect, no event store. The framework does everything around it, in one
// transaction: check idempotency -> `prepare` -> load the model -> `decide` -> append under the
// consistency condition. Run it with `CommandExecutor.run(Deposit, input)`.

// ---------------------------------------------------------------------------------------------
// What `decide` returns: emit events, do nothing, or refuse with a typed error.
// ---------------------------------------------------------------------------------------------

export interface Emit {
  readonly _tag: "Emit";
  readonly events: ReadonlyArray<AppendEvent>;
}
export interface Noop {
  readonly _tag: "Noop";
  readonly reason: string | null;
}
export interface Fail<E> {
  readonly _tag: "Fail";
  readonly error: E;
}
export type Decision<E = never> = Emit | Noop | Fail<E>;

export const emit = (...events: ReadonlyArray<AppendEvent>): Emit => ({ _tag: "Emit", events });
export const noop = (reason: string | null = null): Noop => ({ _tag: "Noop", reason });
export const fail = <E>(error: E): Fail<E> => ({ _tag: "Fail", error });

// The command's error type is INFERRED from what `decide` can return: the union of every `fail(...)`.
type ErrorOf<D> = D extends Fail<infer E> ? E : never;

// A command's DOMAIN errors (those made by `DomainError`) must be declared in its `errors: [...]` list: the list
// is what a transport reads at run time (to present and document them), and this check makes it complete -
// `decide` (and `prepare`) cannot fail with a domain error that is not declared. Errors that are not domain errors
// (a plain value, a framework error) are not subject to it. Evaluates to `unknown` (no constraint) when satisfied,
// and to an object naming the missing classes otherwise, so the compiler's message says which one to add.
type Declared<E, Es extends ReadonlyArray<AnyDomainErrorClass>> = [Extract<E, KindedError>] extends [InstanceType<Es[number]>]
  ? unknown
  : { readonly undeclaredDomainErrors: Exclude<Extract<E, KindedError>, InstanceType<Es[number]>> };

// ---------------------------------------------------------------------------------------------
// How the append is protected against concurrent changes.
// ---------------------------------------------------------------------------------------------

export type Consistency =
  | { readonly _tag: "Strict" }
  | { readonly _tag: "Concurrent"; readonly guard: QueryType | null };

// Fail (with `Conflict`) if ANYTHING in the model's boundary changed since it was loaded. The safe
// default: use it whenever the decision reads state that other commands also change.
export const strict = (): Consistency => ({ _tag: "Strict" });

// Safe to run in parallel with itself - concurrent runs of this command do not conflict with each
// other. Optionally a `guard` query (typically the lifecycle events, e.g. "is the wallet closed?")
// still fails the append if one of THOSE changed since load. The guard must not include event types
// this command appends, or concurrent runs would conflict with each other.
export const concurrent = (opts: { readonly guard?: QueryType } = {}): Consistency => ({
  _tag: "Concurrent",
  guard: opts.guard ?? null
});

// ---------------------------------------------------------------------------------------------
// The defined command.
// ---------------------------------------------------------------------------------------------

// `In` is the DECODED input type and `Err` the union of error instances; `I` and `Es` keep the input Schema and the declared
// error classes themselves, at the type level, so a transport can derive a precisely typed API from them (a typed payload,
// one typed problem per declared error). They default to the erased types, so code that accepts "any command" is unaffected.
export interface Command<
  In,
  Err,
  I extends Schema.Constraint = Schema.Constraint,
  Es extends ReadonlyArray<AnyDomainErrorClass> = ReadonlyArray<AnyDomainErrorClass>
> {
  readonly name: string;
  // The input schema the command validates against (also what a transport documents as its request body).
  readonly input: I;
  // The domain error classes the command can fail with (see `Declared`): what a transport presents and documents.
  readonly errors: Es;
  // Validate untrusted input against the schema. Fails with `InvalidInput`.
  readonly decodeInput: (raw: unknown) => Effect.Effect<In, InvalidInput>;
  // The compiled handler, run by the executor inside its transaction.
  readonly handler: CommandHandler<In, Err | SqlError>;
  // How many times the executor re-runs the whole command (fresh transaction, fresh load) after a
  // `Conflict`, before giving up with that `Conflict`.
  readonly retries: number;
  // Whether a repeat of an already-done operation is reported as success or as `Duplicate`.
  readonly duplicates: "return" | "fail";
  // Whether the command declared `idempotentBy`. An automation requires it: its batch can be handled twice (a crash, a zombie leader), and only an
  // idempotent command makes that harmless.
  readonly idempotent: boolean;
}

export const defaultRetries = 3;

export const defineCommand = <
  I extends Schema.Constraint,
  S = undefined,
  D extends Decision<any> = Decision<never>,
  P = undefined,
  PE = never,
  OD extends "return" | "fail" = "return",
  const Es extends ReadonlyArray<AnyDomainErrorClass> = []
>(def: {
  readonly name: string;
  readonly input: I;
  // The domain errors this command can fail with. Required for every one `decide` or `prepare` can fail with
  // (a missing class is a compile error naming it); omit it for a command with no domain errors.
  readonly errors?: Es;
  // Effectful pre-step that may read (or even append to) the store; its result is passed on as the
  // second argument of `model` and the third of `decide`. Runs inside the command's transaction, so
  // if the command is retried or fails, whatever it appended is rolled back with it. So it is when the command ends as an idempotent repeat or a no-op: that attempt has done nothing,
  // and the executor rolls its transaction back (an idempotent result writes no audit row, so committing would leave those events with no command behind them).
  // What a rollback does NOT cover is racers that both create: two commands that each append in `prepare` and then each succeed both commit. So give every append in `prepare` a
  // condition, so a racer conflicts and runs again instead of appending a second copy: `resolveActivePeriod` (examples/wallet-example-app) opened a statement with none, and commands
  // racing on a new wallet opened three.
  readonly prepare?: (input: Schema.Schema.Type<I>, eventStore: EventStoreService) => Effect.Effect<P, PE> & Declared<PE, Es>;
  // Omit for commands that need no state (e.g. "record that this happened"); `decide` then gets
  // `undefined` and the default consistency is `concurrent()`.
  readonly model?: (input: Schema.Schema.Type<I>, prepared: P) => ModelInstance<S>;
  readonly consistency?: (input: Schema.Schema.Type<I>, prepared: P) => Consistency; // default strict()
  // "Has this exact operation already been done?" as a query. Depends on the INPUT only, so it is
  // checked before `prepare`/`decide` ever run: on a retry the state has moved on (e.g. the balance is
  // already reduced), so re-deciding could wrongly fail. It is also re-checked atomically at append.
  readonly idempotentBy?: (input: Schema.Schema.Type<I>) => QueryType;
  // A repeat is reported as a successful "already done" ("return", the default, safe for retries) or
  // fails with `Duplicate` ("fail", e.g. "open a wallet that already exists").
  readonly onDuplicate?: OD;
  readonly decide: (state: S, input: Schema.Schema.Type<I>, prepared: P) => D & Declared<ErrorOf<D>, Es>;
  // Conflict retries (default 3; 0 turns retrying off).
  readonly retries?: number;
}): Command<Schema.Schema.Type<I>, ErrorOf<D> | PE | (OD extends "fail" ? Duplicate : never), I, Es> => {
  type In = Schema.Schema.Type<I>;
  // The audit table stores the name in a column limited to 64 characters: fail at definition time, not mid-request.
  if (def.name.length < 1 || def.name.length > 64) throw new Error(`command name must be 1-64 characters, got ${def.name.length}: "${def.name}"`);
  const duplicates: "return" | "fail" = def.onDuplicate ?? "return";

  const decode = Schema.decodeUnknownEffect(def.input as unknown as Schema.Decoder<unknown>) as (
    raw: unknown,
    options?: { readonly errors?: "first" | "all" }
  ) => Effect.Effect<In, Schema.SchemaError>;
  // `errors: "all"`: report EVERY failed field, not just the first, so a client can fix them in one go.
  const decodeInput = (raw: unknown) =>
    Effect.mapError(decode(raw, { errors: "all" }), (e) => new InvalidInput({ message: e.message, issues: inputIssuesOf(e) }));

  const handler = ((input: In) =>
    Effect.gen(function* () {
      const eventStore = yield* EventStore;

      // 1. Idempotency pre-check, before anything else (see `idempotentBy`).
      const idempotency = def.idempotentBy?.(input) ?? null;
      if (idempotency !== null) {
        if (Query.isEmpty(idempotency)) {
          return yield* Effect.die(new Error(`command "${def.name}": idempotentBy returned an empty query`));
        }
        if (yield* eventStore.exists(idempotency)) {
          return duplicates === "fail"
            ? yield* Effect.fail(new Duplicate({ message: `Duplicate operation: "${def.name}" was already done` }))
            : CD.noOp("DUPLICATE_OPERATION");
        }
      }

      // 2. Prepare, 3. load the model.
      const prepared = (def.prepare ? yield* def.prepare(input, eventStore) : undefined) as P;
      const model = def.model?.(input, prepared) ?? null;
      const loaded = model !== null ? yield* model.load(eventStore) : null;

      // 4. Decide (pure).
      const decision = def.decide(loaded?.state as S, input, prepared) as Decision<ErrorOf<D>>;
      if (decision._tag === "Fail") return yield* Effect.fail(decision.error);
      if (decision._tag === "Noop") return CD.noOp(decision.reason);
      if (decision.events.length === 0) return CD.noOp("NO_EVENTS");

      // 5. Build the append: events + the condition the chosen consistency implies. A model with a period may bring the events that turn the period (`loaded.prefix`): they go in
      // this same append, ahead of the command's own, and only because the command has events of its own (a refusal, a no-op, an idempotent repeat never get here).
      const consistency = def.consistency?.(input, prepared) ?? (model !== null ? strict() : concurrent());
      const events = [...(loaded?.prefix ?? []), ...decision.events];
      let append: CD.Append;
      if (consistency._tag === "Strict" || (loaded?.prefix?.length ?? 0) > 0) {
        // Turning a period reads more than a commuting command declares (the old period, the entity's periods): the append is strict over everything that was read.
        if (model === null || loaded === null) {
          return yield* Effect.die(new Error(`command "${def.name}": strict consistency needs a model`));
        }
        append = CD.nonCommutative(events, loaded.boundary ?? model.query, loaded.logPosition);
      } else if (consistency.guard !== null || loaded?.guard !== undefined) {
        if (loaded === null) {
          return yield* Effect.die(new Error(`command "${def.name}": a consistency guard needs a model (for its position)`));
        }
        const guard = consistency.guard !== null && loaded.guard !== undefined ? Query.of([...consistency.guard.items, ...loaded.guard.items]) : (consistency.guard ?? loaded.guard!);
        // Throws if the guard includes an event type this command appends (see withLifecycleGuard in CommandDecision.ts).
        append = CD.withLifecycleGuard(events, guard, loaded.logPosition);
      } else {
        append = CD.commutative(...events);
      }
      return idempotency !== null
        ? CD.withIdempotencyQuery(append, idempotency, duplicates === "fail" ? "THROW" : "RETURN_IDEMPOTENT")
        : append;
    })) as CommandHandler<In, ErrorOf<D> | PE | SqlError | (OD extends "fail" ? Duplicate : never)>;

  return { name: def.name, input: def.input, errors: (def.errors ?? []) as unknown as Es, decodeInput, handler, retries: def.retries ?? defaultRetries, duplicates, idempotent: def.idempotentBy !== undefined };
};
