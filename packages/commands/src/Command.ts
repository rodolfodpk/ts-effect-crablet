import { Clock, DateTime, Effect } from "effect";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import { EventStore, existsProjector, type EventStoreService } from "@crablet/eventstore";
import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import * as LogPositionNS from "@crablet/eventstore/LogPosition";
import type { LogPosition } from "@crablet/eventstore/LogPosition";
import * as Query from "@crablet/eventstore/Query";
import type { Query as QueryType } from "@crablet/eventstore/Query";
import * as CD from "./CommandDecision.ts";
import type { CommandHandler } from "./CommandExecutor.ts";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import { IdempotencyMismatch, InvalidInput, inputIssuesOf, type AnyDomainErrorClass, type KindedError } from "./Errors.ts";
import { fingerprintOf, isSameRequest } from "./Repeat.ts";
import type { ModelInstance } from "./Model.ts";

// A command is one declaration of "what happens when this request arrives":
//
//     export const Deposit = defineCommand({
//       name: "deposit",
//       input: Schema.Struct({ walletId: Schema.String, depositId: Schema.String, amount: Schema.Positive }),
//       model: (c) => WalletModel.of({ id: c.walletId, ...period }),           // state + boundary
//       consistency: () => concurrent({ guard: WalletModel.lifecycleQuery(...) }), // optional; default strict()
//       idempotentBy: (c) => DepositMade.where({ deposit_id: c.depositId }),   // how a repeat is recognised (or byModel())
//       decide: (wallet, c) =>
//         wallet.exists ? emit(DepositMade({ ... })) : fail(new WalletNotFound({ walletId: c.walletId }))
//     });
//
// `decide` is PURE: no Effect, no event store. The framework does everything around it, in one
// transaction: check idempotency -> `resolve` (an optional lookup) -> load the model -> `decide` -> append under
// the consistency condition. Run it with `CommandExecutor.run(Deposit, input)`.

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

// What `decide` is told besides the state and the input: the instant of this attempt, as an Effect `DateTime.Utc` (the type an `Instant` field
// holds, so it is stamped on an event as it is), and what `resolve` looked up.
export interface DecideContext<R = undefined> {
  readonly now: DateTime.Utc;
  readonly resolved: R;
}

// What `model` and `consistency` are told besides the input: what `resolve` looked up.
export interface ResolvedContext<R = undefined> {
  readonly resolved: R;
}

// What `resolve` may do with the store: read, never write. Every read joins the command's condition (see `defineCommand`), so a lookup
// that changes before the append refuses it and the command runs again with a fresh lookup.
export interface ResolveReader {
  // The state of a model, as its `load` reads it. A model with a period is read, not turned: its turning events are never appended from here.
  readonly load: <S>(model: ModelInstance<S>) => Effect.Effect<S, SqlError | EventDecodingError>;
  // Whether anything matches `query`.
  readonly exists: (query: QueryType) => Effect.Effect<boolean, SqlError | EventDecodingError>;
}

export const emit = (...events: ReadonlyArray<AppendEvent>): Emit => ({ _tag: "Emit", events });
// "Nothing to do": the decision appends nothing and the command ends as an idempotent success (status IDEMPOTENT; a transport presents it as a success). `reason`
// is what the caller gets back (`ExecutionResult.reason`): give it a short code in UPPER_SNAKE_CASE (ALREADY_SUBSCRIBED, ALREADY_OPENED), like the framework's own
// DUPLICATE_OPERATION (an `idempotentBy` match) and NO_EVENTS (an `emit()` with no events), so a client can switch on it.
export const noop = (reason: string | null = null): Noop => ({ _tag: "Noop", reason });
export const fail = <E>(error: E): Fail<E> => ({ _tag: "Fail", error });

// The command's error type is INFERRED from what `decide` can return: the union of every `fail(...)`.
type ErrorOf<D> = D extends Fail<infer E> ? E : never;

// A command's DOMAIN errors (those made by `DomainError`) must be declared in its `errors: [...]` list: the list
// is what a transport reads at run time (to present and document them), and this check makes it complete -
// `decide` (and `resolve`) cannot fail with a domain error that is not declared. Errors that are not domain errors
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
// How a repeat is recognised, when the model shows it (see `idempotentBy`).
// ---------------------------------------------------------------------------------------------

export interface ByModel {
  readonly _tag: "ByModel";
}

// The effect happens once per key (open wallet X): the model already shows whether it happened, and `decide` answers a repeat - `noop(...)` for the
// same request, a domain error for a different one. It needs a model and decides under `strict()` (the default with a model), so a repeat that races
// the first request conflicts, runs again, and its fresh load shows the first: `consistency` cannot be given with it.
export const byModel = (): ByModel => ({ _tag: "ByModel" });
const isByModel = (value: unknown): value is ByModel => typeof value === "object" && value !== null && (value as ByModel)._tag === "ByModel";

// What `idempotentBy` accepts. `IB` is what was written; a string (the old `"decide"`, a typo) gets a message naming the two forms.
type IdempotentBy<IB, In> = [IB] extends [string]
  ? "idempotentBy takes byModel() or a query, (c) => Event.where({ ... })"
  : (((input: In) => QueryType) | ByModel) & IB;

// The rule above, for the type checker: with `byModel()`, `model` is required and `consistency` is not allowed.
// The text of the `consistency` type is what the compiler shows when one is given.
type ByModelRule<IB> = [IB] extends [ByModel]
  ? { readonly model: unknown; readonly consistency?: "byModel() decides under strict(): remove consistency" }
  : unknown;

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
  readonly handler: CommandHandler<In, Err | SqlError | IdempotencyMismatch>;
  // How many times the executor re-runs the whole command (fresh transaction, fresh load) after a
  // `Conflict`, before giving up with that `Conflict`.
  readonly retries: number;
  // Whether the command declared `idempotentBy`, as a query or as `byModel()`: whether it says how a repeat is recognised. A caller that may repeat a
  // request requires it: a client retries a request whose answer it lost, and an automation's batch can be handled twice (a crash, a zombie leader).
  // Only a command that recognises a repeat makes that harmless. The HTTP API and automations check it when they are built.
  readonly idempotent: boolean;
}

// The input a caller hands to `run` (or a test to `when`): the input before the schema decodes it, so a misspelt or missing field is a compile
// error. For most schemas it is the decoded type; a field read through a transformation (a date from a string) is given in its encoded form.
// `unknown` for a command whose schema type is erased (`Command<In, Err>`), as a transport has it.
export type RawInput<I extends Schema.Constraint> = Schema.Codec.Encoded<I>;

export const defaultRetries = 3;

export const defineCommand = <
  I extends Schema.Constraint,
  S = undefined,
  D extends Decision<any> = Decision<never>,
  R = undefined,
  RE = never,
  const Es extends ReadonlyArray<AnyDomainErrorClass> = [],
  IB = unknown
>(def: {
  readonly name: string;
  readonly input: I;
  // The domain errors this command can fail with. Required for every one `decide` or `resolve` can fail with
  // (a missing class is a compile error naming it); omit it for a command with no domain errors.
  readonly errors?: Es;
  // A lookup before the model is chosen, for when the model's id is not in the input (a card number names a member). It can only READ, and
  // everything it reads joins the command's condition: a strict command's boundary, or a concurrent command's guard. A lookup that
  // changes before the append (the card is cancelled) refuses it, and the command runs again with a fresh lookup. Its result reaches
  // `model`, `consistency` and `decide` as `resolved`.
  readonly resolve?: (input: Schema.Schema.Type<I>, read: ResolveReader) => Effect.Effect<R, RE> & Declared<RE, Es>;
  // Omit for commands that need no state (e.g. "record that this happened"); `decide` then gets
  // `undefined` and the default consistency is `concurrent()`.
  readonly model?: (input: Schema.Schema.Type<I>, context: ResolvedContext<R>) => ModelInstance<S>;
  // Default: `strict()` with a model, `concurrent()` without one. A model can only make a command stricter: without one, `decide` has no
  // state, so there is nothing to protect.
  readonly consistency?: (input: Schema.Schema.Type<I>, context: ResolvedContext<R>) => Consistency;
  // How a repeat of a request is recognised (ADR-0034). Two answers:
  //   - a QUERY, for an effect that can legitimately happen many times (a deposit), keyed on what identifies one REQUEST (a deposit id). It
  //     depends on the INPUT only, so it is checked before `resolve`/`decide` ever run: on a retry the state has moved on (the balance is already
  //     reduced), so re-deciding could wrongly fail. It is re-checked atomically at append. A match from the same request is "already done",
  //     with the earlier write's marker; a match from a DIFFERENT request (same key, another body) fails with `IdempotencyMismatch`.
  //   - `byModel()`, for an effect that can only happen once per key (open wallet X): the model already shows whether it happened, and `decide`
  //     answers the repeat itself - `noop(...)` for the same request, a domain error for a different one. Nothing is looked up for it.
  //     It needs a model and decides under strict() (no `consistency`): a racing repeat conflicts, reloads, and `decide` sees the first.
  // Required by any caller that may repeat a request (a client retry, an automation redelivery); `assertRepeatHarmless` (testing) checks the answer.
  readonly idempotentBy?: IdempotentBy<IB, Schema.Schema.Type<I>>;
  // `context.now` is the instant of this attempt, from the clock (the one a model with a period decided its period at): stamp events with it (`subscribedAt: now`, with an `Instant` field) instead of `new Date()`, so a timestamp and a period agree, also under a test clock.
  readonly decide: (state: S, input: Schema.Schema.Type<I>, context: DecideContext<R>) => D & Declared<ErrorOf<D>, Es>;
  // Conflict retries (default 3; 0 turns retrying off).
  readonly retries?: number;
} & ByModelRule<IB>): Command<Schema.Schema.Type<I>, ErrorOf<D> | RE, I, Es> => {
  type In = Schema.Schema.Type<I>;
  // The audit table stores the name in a column limited to 64 characters: fail at definition time, not mid-request.
  if (def.name.length < 1 || def.name.length > 64) throw new Error(`command name must be 1-64 characters, got ${def.name.length}: "${def.name}"`);
  // The byModel() rule, also for callers the type checker does not see (ADR-0034).
  if (isByModel(def.idempotentBy)) {
    if (def.model === undefined) throw new Error(`command "${def.name}": idempotentBy byModel() needs a model, the state decide answers a repeat from`);
    if (def.consistency !== undefined) {
      throw new Error(`command "${def.name}": idempotentBy byModel() decides under strict(), so it takes no consistency: under concurrent(), two identical requests racing would both append`);
    }
  }

  const decode = Schema.decodeUnknownEffect(def.input as unknown as Schema.Decoder<unknown>) as (
    raw: unknown,
    options?: { readonly errors?: "first" | "all" }
  ) => Effect.Effect<In, Schema.SchemaError>;
  // `errors: "all"`: report EVERY failed field, not just the first, so a client can fix them in one go.
  const decodeInput = (raw: unknown) =>
    Effect.mapError(decode(raw, { errors: "all" }), (e) => new InvalidInput({ message: e.message, issues: inputIssuesOf(e) }));

  const mismatch = new IdempotencyMismatch({
    command: def.name,
    message: `command "${def.name}": this request's key was already used by a different request; the earlier one stands and this one was not applied`
  });

  const handler = ((input: In) =>
    Effect.gen(function* () {
      const eventStore = yield* EventStore;

      // 1. Idempotency pre-check, before anything else (see `idempotentBy`): a repeat of the same request is "already done", with the earlier
      // write's marker; the same key from a different request is refused.
      const idempotency = typeof def.idempotentBy === "function" ? (def.idempotentBy as (input: In) => QueryType)(input) : null;
      // The request's fingerprint: compared when the key repeats, and, under a cause (an automation's trigger), the database's backstop against the same
      // trigger appending the same request twice (ADR-0035).
      const causationId = yield* CorrelationContext.causationId;
      const fingerprint = idempotency !== null || causationId !== null ? yield* fingerprintOf(def.name, def.input, input) : null;
      if (idempotency !== null) {
        if (Query.isEmpty(idempotency)) {
          return yield* Effect.die(new Error(`command "${def.name}": idempotentBy returned an empty query`));
        }
        const duplicate = yield* eventStore.findDuplicate(idempotency);
        if (duplicate !== null) {
          if (!isSameRequest(duplicate, fingerprint, causationId)) return yield* mismatch;
          return CD.noOp("DUPLICATE_OPERATION", duplicate.latest);
        }
      }

      // 2. Resolve (a lookup through a reader that records what it read), 3. load the model.
      const reads: Array<{ readonly query: QueryType; readonly horizon: LogPosition }> = [];
      const reader: ResolveReader = {
        load: (m) => Effect.map(m.load(eventStore), (l) => (reads.push({ query: l.boundary ?? m.query, horizon: l.horizon }), l.state)),
        exists: (query) =>
          Query.isEmpty(query)
            ? Effect.die(new Error(`command "${def.name}": resolve asked whether an empty query exists`))
            : Effect.map(eventStore.project(query, LogPositionNS.zero(), [existsProjector()]), (r) => (reads.push({ query, horizon: r.horizon }), r.state))
      };
      const resolved = (def.resolve ? yield* def.resolve(input, reader) : undefined) as R;
      const model = def.model?.(input, { resolved }) ?? null;
      const loaded = model !== null ? yield* model.load(eventStore) : null;

      // 4. Decide (pure).
      const now = DateTime.fromDateUnsafe(loaded?.now ?? new Date(yield* Clock.currentTimeMillis));
      const decision = def.decide(loaded?.state as S, input, { now, resolved }) as Decision<ErrorOf<D>>;
      if (decision._tag === "Fail") return yield* Effect.fail(decision.error);
      // A no-op answers with the newest event the decision read: whatever made it "already done" is at or before it.
      if (decision._tag === "Noop") return CD.noOp(decision.reason, markerOf(loaded?.latest));
      if (decision.events.length === 0) return CD.noOp("NO_EVENTS", markerOf(loaded?.latest));

      // An event the command's own model handles, about its entity, needs the tags the model reads it by (its scope, the period it decided in), or
      // the next load, and the boundary, would miss it: the missing ones are added here (ADR-0041). One tagged with another value is refused, and
      // nothing is appended.
      const own: Array<AppendEvent> = [];
      for (const event of decision.events) {
        const completed = loaded?.complete?.(event) ?? { event, conflicts: [] };
        if (completed.conflicts.length > 0) {
          return yield* Effect.die(
            new Error(
              `command "${def.name}": its model reads ${event.type} by the tags ${completed.conflicts.join(", ")}, but the event carries another value for ` +
                `${completed.conflicts.length === 1 ? "it" : "them"}; the next load, and the boundary, would miss it. Nothing was appended.`
            )
          );
        }
        own.push(completed.event);
      }

      // byModel() claims that the model shows the request was done, and `decide` answers its repeat (ADR-0034). Checked on every write, in memory:
      // after the command's own events, the same request must be answered `noop(...)`. If not, a retry would append again (or fail where it
      // succeeded), so nothing is appended.
      if (isByModel(def.idempotentBy) && loaded?.fold !== undefined) {
        const again = def.decide(loaded.fold(loaded.state as S, own), input, { now, resolved }) as Decision<ErrorOf<D>>;
        if (again._tag !== "Noop") {
          return yield* Effect.die(
            new Error(
              `command "${def.name}": idempotentBy byModel() says the model shows the request was done, but after its own events decide ` +
                `${again._tag === "Fail" ? "fails" : "appends again"} for the same request instead of answering noop(...): a retry would ${again._tag === "Fail" ? "fail where it succeeded" : "do the work twice"}. Nothing was appended.`
            )
          );
        }
      }

      // 5. Build the append: events + the condition the chosen consistency implies. A model with a period may bring the events that turn the period (`loaded.prefix`): they go in
      // this same append, ahead of the command's own, and only because the command has events of its own (a refusal, a no-op, an idempotent repeat never get here).
      // What `resolve` read joins the condition the way `all(...)` joins its members: the queries are added, and the cursor is the earliest read horizon (Model.ts, `all`).
      const consistency = def.consistency?.(input, { resolved }) ?? (model !== null ? strict() : concurrent());
      const events = [...(loaded?.prefix ?? []), ...own];
      const readQuery = reads.length > 0 ? Query.of(reads.flatMap((r) => r.query.items)) : null;
      const cursorFrom = (base: LogPosition | null): LogPosition =>
        reads.reduce<LogPosition | null>((c, r) => (c === null ? r.horizon : LogPositionNS.earliest(c, r.horizon)), base) ?? LogPositionNS.zero();
      // The cursor of a condition over the model and the lookups: the model's own position when nothing was looked up (as before), else the earliest horizon of all reads.
      const cursor = (): LogPosition => (reads.length === 0 ? loaded!.logPosition : cursorFrom(loaded?.horizon ?? null));
      // A lookup cannot be a guard over an event this command appends (concurrent runs would refuse each other): then the condition is strict.
      const appended = new Set(events.map((e) => e.type));
      const lookupOverlapsAppend = readQuery !== null && readQuery.items.some((item) => item.eventTypes.some((t) => appended.has(t)));
      let append: CD.Append;
      if (consistency._tag === "Strict" || (loaded?.prefix?.length ?? 0) > 0 || lookupOverlapsAppend) {
        // Turning a period reads more than a commuting command declares (the old period, the entity's periods): the append is strict over everything that was read.
        if (loaded === null && readQuery === null) {
          return yield* Effect.die(new Error(`command "${def.name}": strict consistency needs a model`));
        }
        const boundary = Query.of([...(loaded !== null ? (loaded.boundary ?? model!.query).items : []), ...(readQuery?.items ?? [])]);
        append = CD.nonCommutative(events, boundary, cursor());
      } else if (consistency.guard !== null || loaded?.guard !== undefined || readQuery !== null) {
        if (loaded === null && readQuery === null) {
          return yield* Effect.die(new Error(`command "${def.name}": a consistency guard needs a model (for its position)`));
        }
        const guard = Query.of([...(consistency.guard?.items ?? []), ...(loaded?.guard?.items ?? []), ...(readQuery?.items ?? [])]);
        // Throws if the guard includes an event type this command appends (see withLifecycleGuard in CommandDecision.ts).
        append = CD.withLifecycleGuard(events, guard, loaded === null ? cursorFrom(null) : cursor());
      } else {
        append = CD.commutative(...events);
      }
      return { ...(idempotency !== null ? CD.withIdempotencyQuery(append, idempotency) : append), requestFingerprint: fingerprint };
    })) as CommandHandler<In, ErrorOf<D> | RE | SqlError | IdempotencyMismatch>;

  return { name: def.name, input: def.input, errors: (def.errors ?? []) as unknown as Es, decodeInput, handler, retries: def.retries ?? defaultRetries, idempotent: def.idempotentBy !== undefined };
};

// A read position as a marker, or null when it points at nothing (the start of the log).
const markerOf = (position: LogPosition | undefined): CD.NoOp["marker"] =>
  position === undefined || position.position === 0n || position.transactionId === null || position.transactionId === "0"
    ? null
    : { position: position.position, transactionId: position.transactionId };
