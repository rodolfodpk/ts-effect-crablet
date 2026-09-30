import { Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import type { EventStoreService, StateProjector, StoredEvent } from "@crablet/eventstore";
import * as LogPositionNS from "@crablet/eventstore/LogPosition";
import type { LogPosition } from "@crablet/eventstore/LogPosition";
import * as Query from "@crablet/eventstore/Query";
import * as Tag from "@crablet/eventstore/Tag";

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
}

export interface ModelInstance<S> {
  readonly query: Query.Query;
  readonly load: (eventStore: EventStoreService) => Effect.Effect<Loaded<S>, SqlError>;
}

interface OnEntry<S> {
  readonly type: string;
  readonly lifecycle: boolean;
  readonly by: ReadonlyArray<string> | null;
  readonly apply: (state: S, raw: unknown, ctx: HandlerCtx) => S;
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
  const build = (entries: ReadonlyArray<OnEntry<S>>): ModelBuilder<S, Scope> => {
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
      build([
        ...entries,
        {
          type: event.type,
          lifecycle: opts.lifecycle ?? false,
          by: opts.by ?? null,
          apply: (state, raw, ctx) => apply(state, event.decode(raw), ctx)
        }
      ]);

    return {
      on: (event, apply, opts) => add(event, apply, opts),
      lifecycle: (event, apply) => add(event, apply, { lifecycle: true }),
      lifecycleQuery: (id) => queryFor(id, [], true),
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
        return {
          query,
          load: (eventStore) =>
            Effect.map(eventStore.project(query, LogPositionNS.zero(), [projector]), (r) => ({
              state: r.state,
              logPosition: r.logPosition
            }))
        };
      }
    };
  };
  return build([]);
};

const positionOnly: StateProjector<null> = { eventTypes: [], initialState: null, transition: (s) => s };

// A model over SEVERAL entities at once (e.g. both wallets of a transfer): one boundary - the union
// of the members' queries - one log position, and each member's own state.
//
//     all({ from: WalletModel.of({ id: a }), to: WalletModel.of({ id: b }) })   // state: { from, to }
//
// The boundary is read FIRST, then each member. Events committed in between can only make a member's
// state newer than the boundary position, never older, so a race shows up as an extra (safe)
// conflict at append time, never as a missed one.
export const all = <M extends Record<string, ModelInstance<any>>>(
  members: M
): ModelInstance<{ readonly [K in keyof M]: M[K] extends ModelInstance<infer S> ? S : never }> => {
  const query = Query.of(Object.values(members).flatMap((m) => m.query.items));
  return {
    query,
    load: (eventStore) =>
      Effect.gen(function* () {
        const boundary = yield* eventStore.project(query, LogPositionNS.zero(), [positionOnly]);
        const states = yield* Effect.forEach(Object.entries(members), ([key, member]) =>
          Effect.map(member.load(eventStore), (loaded) => [key, loaded.state] as const)
        );
        return { state: Object.fromEntries(states) as never, logPosition: boundary.logPosition };
      })
  };
};
