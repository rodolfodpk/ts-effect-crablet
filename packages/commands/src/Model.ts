import { Effect, Metric, Option } from "effect";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import type { EventStoreService, StateProjector, StoredEvent } from "@crablet/eventstore";
import * as LogPositionNS from "@crablet/eventstore/LogPosition";
import type { LogPosition } from "@crablet/eventstore/LogPosition";
import * as Query from "@crablet/eventstore/Query";
import * as Tag from "@crablet/eventstore/Tag";
import { SnapshotCollector, SnapshotStore, canonicalQuery } from "@crablet/eventstore/SnapshotStore";
import * as SnapshotMetrics from "@crablet/metrics-otel/SnapshotMetrics";

// A model answers two questions about one entity (or a group of them):
//
//   1. STATE - what do the events mean right now? A pure fold: `(state, event) => state`.
//   2. BOUNDARY - which events could change that answer? A `Query` over the shared event log.
//
// Both come from the same declaration, so the fold and the boundary cannot drift apart: the query is
// derived from the events the fold handles. A command loads a model, decides on the state, and
// appends with a condition that fails if anything in the boundary changed since it was loaded.
//
//     const WalletModel = defineModel({ by: "wallet_id", initial: () => ({ exists: false, balance: 0 }) })
//       .lifecycle(WalletOpened, (_, d) => ({ exists: true, balance: d.initialBalance }))
//       .on(DepositMade, (w, d) => ({ ...w, balance: d.newBalance }));
//
//     WalletModel.of({ id: "w1" }).load(eventStore)   // -> { state, logPosition }
//
// The builder is chained (not an array of handlers) on purpose: the state type is fixed by `initial`
// BEFORE any handler is written, so every handler's parameters are fully inferred. A nested generic
// call inside an array literal cannot be driven by the enclosing call's in-progress inference - the
// state type collapses to `unknown`.

type TagValue = string | number;
type EventLike = { readonly type: string; readonly decode: (raw: unknown) => any };
type DataOf<E> = E extends { readonly decode: (raw: unknown) => infer D } ? D : never;

export interface HandlerCtx {
  // The full stored event, including its tags (e.g. to tell which side of a two-party event this is).
  readonly event: StoredEvent;
  // The id this model instance was built for (e.g. the wallet this state is about).
  readonly id: string;
}
export type Handler<S, D> = (state: S, data: D, ctx: HandlerCtx) => S;

export interface Loaded<S> {
  readonly state: S;
  // The log position of the newest event in the boundary at load time. An append condition built
  // from `(query, logPosition)` means "fail if anything in the boundary is newer than this".
  readonly logPosition: LogPosition;
  // A cursor before anything this load could have missed (see `ProjectionResult.horizon`); what `all` builds its cursor from.
  readonly horizon: LogPosition;
}

export interface ModelInstance<S> {
  readonly query: Query.Query;
  // Present when the model declared `.snapshot(...)`: what verify-snapshots needs to check its rows (name, version, state schema).
  readonly snapshot?: { readonly name: string; readonly version: number; readonly schema: Schema.Schema<any> };
  // What the model accounts for, as data (for the change-impact report, DCB rule A: ModelImpact.ts): the event types it handles, the ones it declared with `.ignores(...)`,
  // and the tag keys it binds by.
  readonly handles?: ReadonlyArray<string>;
  readonly ignores?: ReadonlyArray<string>;
  readonly bindings?: ReadonlyArray<string>;
  // `EventDecodingError`: a stored event in the boundary that its definition cannot read (ADR-0017); never skipped.
  readonly load: (eventStore: EventStoreService) => Effect.Effect<Loaded<S>, SqlError | EventDecodingError>;
}

interface OnEntry<S> {
  readonly type: string;
  readonly lifecycle: boolean;
  readonly by: ReadonlyArray<string> | null;
  readonly apply: (state: S, raw: unknown, ctx: HandlerCtx) => S;
}

// Opt-in snapshots of a model's state (ADR-0018): a load reads the stored state and only the events after its cursor, instead of the whole boundary.
export interface SnapshotOptions<S> {
  // Identifies the model's snapshots (1-64 characters). With the boundary query (so: the entity) and `version`, it is the key.
  readonly name: string;
  // Bump it when the fold changes what it does with events it already handled: the old snapshots are then never read. (A changed set of handled events
  // changes the boundary query, so it changes the key by itself.)
  readonly version: number;
  // Describes the state. It must round-trip through JSON (no Map, Set, Date or bigint in the state). A stored state that no longer decodes is ignored.
  readonly schema: Schema.Schema<S>;
  // Write a snapshot after a load that folded at least this many events (default 1,000).
  readonly every?: number;
}

export interface ModelBuilder<S, Scope extends object> {
  // Handle an event of this kind. By default it is bound to the model's id via the `by` tag and
  // scoped by the model's `scope` tags. `by` lists other tag keys to bind through instead - one
  // query item per key, e.g. a transfer event touches a wallet as `from_wallet_id` OR `to_wallet_id`.
  on<E extends EventLike>(
    event: E,
    apply: Handler<S, DataOf<E>>,
    opts?: { readonly by?: ReadonlyArray<string> }
  ): ModelBuilder<S, Scope>;
  // Like `on`, for lifecycle events (open/close): bound by id only and NOT scoped, because they
  // matter regardless of which period or scope the model instance is about.
  lifecycle<E extends EventLike>(event: E, apply: Handler<S, DataOf<E>>): ModelBuilder<S, Scope>;
  // Declare event types that carry this model's binding tags but are deliberately NOT part of its decision. Changes nothing at runtime (the boundary and the fold
  // are the same); it records the intent, which the change-impact report (ModelImpact.ts, ADR-0017 rule A) reads to tell "forgotten" from "not relevant".
  ignores(...events: ReadonlyArray<EventLike>): ModelBuilder<S, Scope>;
  // Opt this model in to snapshots. Chain it last: the state type is already fixed by `initial`.
  snapshot(options: SnapshotOptions<S>): ModelBuilder<S, Scope>;
  of(args: { readonly id: string } & Scope): ModelInstance<S>;
  // Just the lifecycle events' query: the natural "guard" for a command that is otherwise
  // commutative (see withLifecycleGuard in CommandDecision.ts).
  lifecycleQuery(id: string): Query.Query;
}

export const defineModel = <S, Scope extends object = {}>(def: {
  // Default tag key that binds an event to this model's id (e.g. "wallet_id").
  readonly by: string;
  readonly initial: () => S;
  // Extra tags that narrow the non-lifecycle events to a slice (e.g. a year/month period).
  readonly scope?: (scope: Scope) => Record<string, TagValue>;
}): ModelBuilder<S, Scope> => {
  const build = (entries: ReadonlyArray<OnEntry<S>>, snap: SnapshotOptions<S> | null, ignored: ReadonlyArray<string> = []): ModelBuilder<S, Scope> => {
    // Group entries into query items by (lifecycle?, binding tag): events of several types that are
    // bound the same way share one item (type any-of, tags all-of).
    const queryFor = (id: string, scopeTags: ReadonlyArray<Tag.Tag>, lifecycleOnly: boolean): Query.Query => {
      const groups = new Map<string, { types: Array<string>; tags: ReadonlyArray<Tag.Tag> }>();
      for (const entry of entries) {
        if (lifecycleOnly && !entry.lifecycle) continue;
        for (const binding of entry.by ?? [def.by]) {
          const key = `${entry.lifecycle ? "L" : "S"}|${binding}`;
          const group = groups.get(key) ?? {
            types: [],
            tags: [Tag.of(binding, id), ...(entry.lifecycle ? [] : scopeTags)]
          };
          if (!group.types.includes(entry.type)) group.types.push(entry.type);
          groups.set(key, group);
        }
      }
      return Query.of([...groups.values()].map((g) => Query.queryItemOf(g.types, g.tags)));
    };

    const byType = new Map(entries.map((e) => [e.type, e] as const));
    const eventTypes = [...byType.keys()];

    const add = <E extends EventLike>(
      event: E,
      apply: Handler<S, DataOf<E>>,
      opts: { readonly lifecycle?: boolean; readonly by?: ReadonlyArray<string> } = {}
    ) =>
      build(
        [
          ...entries,
          {
            type: event.type,
            lifecycle: opts.lifecycle ?? false,
            by: opts.by ?? null,
            apply: (state, raw, ctx) => apply(state, event.decode(raw), ctx)
          }
        ],
        snap,
        ignored
      );

    return {
      on: (event, apply, opts) => add(event, apply, opts),
      lifecycle: (event, apply) => add(event, apply, { lifecycle: true }),
      lifecycleQuery: (id) => queryFor(id, [], true),
      snapshot: (options) => build(entries, options, ignored),
      // a declaration only: the boundary and the fold are untouched
      ignores: (...events) => build(entries, snap, [...new Set([...ignored, ...events.map((e) => e.type)])]),
      of: (args) => {
        const scopeTags = Object.entries(def.scope?.(args as never) ?? {}).map(([k, v]) => Tag.of(k, String(v)));
        const query = queryFor(args.id, scopeTags, false);
        const projector: StateProjector<S> = {
          eventTypes,
          initialState: def.initial(),
          transition: (state, event) => {
            const entry = byType.get(event.type);
            return entry ? entry.apply(state, event.data, { event, id: args.id }) : state;
          }
        };
        const loaded = (r: { readonly state: S; readonly logPosition: LogPosition; readonly horizon: LogPosition }): Loaded<S> => ({
          state: r.state,
          logPosition: r.logPosition,
          horizon: r.horizon
        });
        return {
          query,
          ...(snap === null ? {} : { snapshot: { name: snap.name, version: snap.version, schema: snap.schema } }),
          handles: eventTypes,
          ignores: ignored,
          bindings: [...new Set([def.by, ...entries.flatMap((e) => e.by ?? [])])],
          load: (eventStore) =>
            snap === null
              ? Effect.map(eventStore.project(query, LogPositionNS.zero(), [projector]), loaded)
              : loadWithSnapshot(eventStore, query, projector, snap, def.initial, args)
        };
      }
    };
  };
  return build([], null);
};

const stateFromSnapshot = <S>(schema: Schema.Schema<S>, raw: unknown): { readonly state: S } | null => {
  try {
    return { state: Schema.decodeUnknownSync(schema as never)(raw) as S };
  } catch {
    return null;
  }
};

// Load = the stored snapshot (if usable) + the events after its cursor. Everything about the snapshot FAILS OPEN to the full fold, except an error from the
// database itself (a missing table, a dead connection), which is reported like any other: a model that opted in on a database without migration V9 is a
// misconfiguration to see, not to paper over. After the load, a snapshot is RECORDED for the executor to write after the transaction, when the load folded
// at least `every` events and the cursor moved.
const loadWithSnapshot = <S>(
  eventStore: EventStoreService,
  query: Query.Query,
  projector: StateProjector<S>,
  snap: SnapshotOptions<S>,
  initial: () => S,
  entity: object
): Effect.Effect<Loaded<S>, SqlError | EventDecodingError> =>
  Effect.gen(function* () {
    const count = (outcome: string) => Metric.update(Metric.withAttributes(SnapshotMetrics.loads, { model: snap.name, outcome }), 1);
    const store = yield* Effect.serviceOption(SnapshotStore);
    const key = { name: snap.name, version: snap.version, canonical: canonicalQuery(query) };
    const stored = Option.isSome(store) ? yield* store.value.get(key) : null;
    const start = stored === null ? null : stateFromSnapshot(snap.schema, stored.state);
    const outcome = Option.isNone(store) ? "unavailable" : stored === null ? "miss" : start === null ? "invalid" : "hit";
    yield* count(outcome);

    const after = start === null ? LogPositionNS.zero() : stored!.cursor;
    let folded = 0;
    const counting: StateProjector<S> = {
      eventTypes: projector.eventTypes,
      initialState: start === null ? initial() : start.state,
      transition: (state, event) => {
        folded++;
        return projector.transition(state, event);
      }
    };
    const r = yield* eventStore.project(query, after, [counting]);
    yield* Metric.update(Metric.withAttributes(SnapshotMetrics.foldedEvents, { model: snap.name }), folded);

    const advanced = r.logPosition.position !== after.position || r.logPosition.transactionId !== after.transactionId;
    if (Option.isSome(store) && folded >= (snap.every ?? 1_000) && advanced && r.logPosition.position > 0n && r.logPosition.transactionId !== null) {
      const collector = yield* Effect.serviceOption(SnapshotCollector);
      if (Option.isSome(collector)) {
        try {
          const encoded = (Schema.encodeSync(snap.schema as never) as unknown as (state: S) => unknown)(r.settledState);
          yield* collector.value.add({ ...key, cursor: r.logPosition, state: encoded, entity });
        } catch (error) {
          yield* Effect.logWarning(`snapshot ${snap.name}: the state does not encode with its schema, no snapshot recorded: ${String(error)}`);
        }
      }
    }
    return { state: r.state, logPosition: r.logPosition, horizon: r.horizon };
  });

// A model over SEVERAL entities at once (e.g. both wallets of a transfer): one boundary - the union
// of the members' queries - one cursor, and each member's own state.
//
//     all({ from: WalletModel.of({ id: a }), to: WalletModel.of({ id: b }) })   // state: { from, to }
//
// Each member loads on its own and reports its read HORIZON (ProjectionResult.horizon): a cursor before every event
// its read could have missed. The cursor of the whole is the EARLIEST horizon, so no member's missed event can sort
// before it (never a missed conflict); events a member did see and that had settled sort before it too (so no
// conflict for ever). The maximum of the members' newest events would be unsafe and the minimum would refuse for
// ever: docs/adr/0018-model-snapshots.md, decision 8, proved by eventstore's union-boundary-cursor test. The union
// itself is never read just to learn a position.
export const all = <M extends Record<string, ModelInstance<any>>>(
  members: M
): ModelInstance<{ readonly [K in keyof M]: M[K] extends ModelInstance<infer S> ? S : never }> => {
  const query = Query.of(Object.values(members).flatMap((m) => m.query.items));
  return {
    query,
    load: (eventStore) =>
      Effect.gen(function* () {
        const loaded = yield* Effect.forEach(Object.entries(members), ([key, member]) =>
          Effect.map(member.load(eventStore), (l) => [key, l] as const)
        );
        const horizons = loaded.map(([, l]) => l.horizon);
        const horizon = horizons.length === 0 ? LogPositionNS.zero() : horizons.reduce((a, b) => LogPositionNS.earliest(a, b));
        return { state: Object.fromEntries(loaded.map(([key, l]) => [key, l.state])) as never, logPosition: horizon, horizon };
      })
  };
};
