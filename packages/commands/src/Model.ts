import { Clock, Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import type { EventStoreService, StateProjector, StoredEvent } from "@crablet/eventstore";
import * as LogPositionNS from "@crablet/eventstore/LogPosition";
import type { LogPosition } from "@crablet/eventstore/LogPosition";
import * as Query from "@crablet/eventstore/Query";
import * as Tag from "@crablet/eventstore/Tag";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import { tagsOf, type PeriodFields, type PeriodSpec } from "./Period.ts";

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
  // Only a model with a period (`.period`) sets these three. `prefix`: the events that turn the period (close the old one, open the new one), appended in the same append as the
  // command's own events and only if the command appends any. `boundary`: the query the append is conditioned on, when it is not the model's static `query` (a turn reads more than it
  // declares). `guard`: what a command that only needs to commute with itself must still conflict with - here, the closing of the period it decided in.
  readonly prefix?: ReadonlyArray<AppendEvent>;
  readonly boundary?: Query.Query;
  readonly guard?: Query.Query;
}

export interface ModelInstance<S> {
  readonly query: Query.Query;
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

// Group entries into query items by (lifecycle?, binding tag): events of several types that are
// bound the same way share one item (type any-of, tags all-of).
const queryOf = <S>(entries: ReadonlyArray<OnEntry<S>>, by: string, id: string, scopeTags: ReadonlyArray<Tag.Tag>, lifecycleOnly: boolean): Query.Query => {
  const groups = new Map<string, { types: Array<string>; tags: ReadonlyArray<Tag.Tag> }>();
  for (const entry of entries) {
    if (lifecycleOnly && !entry.lifecycle) continue;
    for (const binding of entry.by ?? [by]) {
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
  of(args: { readonly id: string } & Scope): ModelInstance<S>;
  // Just the lifecycle events' query: the natural "guard" for a command that is otherwise
  // commutative (see withLifecycleGuard in CommandDecision.ts).
  lifecycleQuery(id: string): Query.Query;
  // Declare the model's PERIOD (docs/plans/period-rollover.md): the cycle after which one statement, shift or page is closed and the next opened with the state carried forward. The model
  // then needs no `scope`: the period is the scope, and the instance is built from the id alone (`Model.of({ id })`). On every load the framework reads the clock, finds the period "now" falls in,
  // and, if the entity's open period is an older one, returns the events that turn it (`closed` for the old, `opened` for the new, built by `close` and `open`) for the command to append in its own
  // append - atomically, under one condition - or not at all if the command appends nothing. `opened` must already have a handler (`.on(opened, ...)`) that folds what `open` carried forward.
  // `open` and `close` run for every turn, also for an entity that does not exist yet (the command's `decide` then refuses and the events are dropped): keep them total.
  // The state the command's `decide` receives is the model's, plus `period: { key, fields, tags }` of the period it decided in.
  period<F extends PeriodFields, OD, CD>(
    spec: PeriodSpec<F>,
    config: {
      readonly opened: PeriodEvent<OD>;
      readonly closed: PeriodEvent<CD>;
      readonly open: (carry: S, period: PeriodContext<F>) => OD;
      readonly close: (state: S, period: PeriodContext<F>) => CD;
    }
  ): PeriodModel<S & { readonly period: PeriodInfo<F> }>;
}

// The event definitions a period is opened and closed with (`defineEvent`'s result): callable, with the type and decoder.
export type PeriodEvent<D> = { (data: D, extraTags?: ReadonlyArray<Tag.Tag>): AppendEvent; readonly type: string; readonly decode: (raw: unknown) => any };

export interface PeriodInfo<F> {
  readonly key: string;
  readonly fields: F;
  // The tags that place an event in this period: put them on the events the command appends (`Event(data, state.period.tags)`).
  readonly tags: ReadonlyArray<Tag.Tag>;
}
export interface PeriodContext<F> {
  readonly id: string;
  readonly key: string;
  readonly fields: F;
  // The instant of the turn, ISO 8601, from the clock.
  readonly at: string;
}
export interface PeriodModel<S> {
  readonly of: (args: { readonly id: string }) => ModelInstance<S>;
  readonly lifecycleQuery: (id: string) => Query.Query;
}

const unionOf = (...queries: ReadonlyArray<Query.Query | undefined>): Query.Query => Query.of(queries.flatMap((q) => q?.items ?? []));

const periodModel = <S, F extends PeriodFields, OD, CD>(
  declared: ReadonlyArray<OnEntry<S>>,
  ignored: ReadonlyArray<string>,
  def: { readonly by: string; readonly initial: () => S },
  spec: PeriodSpec<F>,
  config: { readonly opened: PeriodEvent<OD>; readonly closed: PeriodEvent<CD>; readonly open: (carry: S, period: PeriodContext<F>) => OD; readonly close: (state: S, period: PeriodContext<F>) => CD }
): PeriodModel<S & { readonly period: PeriodInfo<F> }> => {
  const { opened, closed } = config;
  if (!declared.some((e) => e.type === opened.type)) {
    throw new Error(`.period: the model has no handler for its opening event "${opened.type}"; add .on(${opened.type}, ...) that folds what \`open\` carries forward (an opening balance, say)`);
  }
  // The closing event is part of the boundary even when the model's state does not depend on it: a command that decided in a period conflicts if the period closed since.
  const entries: ReadonlyArray<OnEntry<S>> = declared.some((e) => e.type === closed.type)
    ? declared
    : [...declared, { type: closed.type, lifecycle: false, by: null, apply: (state: S) => state }];
  const byType = new Map(entries.map((e) => [e.type, e] as const));
  const eventTypes = [...byType.keys()];
  const openedEntry = byType.get(opened.type)!;
  // The events the turn builds must carry the model's binding tag and the tags of the level: without them a period's query would never find its own opening, and every command would open it again.
  const requireTags = (event: AppendEvent, of: string): AppendEvent => {
    const have = new Set(event.tags.map((t) => t.key));
    for (const key of [def.by, ...spec.tagKeys]) {
      if (!have.has(key)) throw new Error(`.period: the event "${of}" does not carry the tag "${key}" (it needs ${[def.by, ...spec.tagKeys].map((k) => `"${k}"`).join(", ")} to be found as its period's ${of === opened.type ? "opening" : "closing"})`);
    }
    return event;
  };
  const info = (fields: F): PeriodInfo<F> => ({ key: spec.key(fields), fields, tags: tagsOf(spec, fields) });

  // The entity's periods as the log says: the one the last opening opened, unless a later closing closed it.
  const trackingQuery = (id: string): Query.Query => Query.of([Query.queryItemOf([opened.type, closed.type], [Tag.of(def.by, id)])]);
  const fieldsIn = (event: { readonly type: string; readonly data: unknown }, which: PeriodEvent<any>): F => {
    const fields = spec.fieldsOf(which.decode(event.data));
    if (fields === null) throw new Error(`.period: the event "${which.type}" does not carry the fields of its period (${spec.tagKeys.join(", ")})`);
    return fields;
  };
  const tracking: StateProjector<F | null> = {
    eventTypes: [opened.type, closed.type],
    initialState: null,
    transition: (open, event) => {
      if (event.type === opened.type) return fieldsIn(event, opened);
      return open !== null && spec.key(fieldsIn(event, closed)) === spec.key(open) ? null : open;
    }
  };
  const closingQuery = (id: string, fields: F): Query.Query => Query.of([Query.queryItemOf([closed.type], [Tag.of(def.by, id), ...tagsOf(spec, fields)])]);

  // One read of the model scoped to a period, remembering whether that period's opening and closing were seen.
  type Marked = { readonly s: S; readonly opened: boolean; readonly closed: boolean };
  const read = (eventStore: EventStoreService, id: string, fields: F) => {
    const query = queryOf(entries, def.by, id, tagsOf(spec, fields), false);
    const projector: StateProjector<Marked> = {
      eventTypes,
      initialState: { s: def.initial(), opened: false, closed: false },
      transition: (m, event) => {
        const entry = byType.get(event.type);
        return {
          s: entry ? entry.apply(m.s, event.data, { event, id }) : m.s,
          opened: m.opened || event.type === opened.type,
          closed: m.closed || event.type === closed.type
        };
      }
    };
    return Effect.map(eventStore.project(query, LogPositionNS.zero(), [projector]), (r) => ({ ...r.state, query, logPosition: r.logPosition, horizon: r.horizon }));
  };

  const load = (eventStore: EventStoreService, id: string) =>
    Effect.gen(function* () {
      const now = new Date(yield* Clock.currentTimeMillis);
      const at = now.toISOString();
      const context = (fields: F): PeriodContext<F> => ({ id, key: spec.key(fields), fields, at });
      const target = spec.fieldsAt(now);
      const withPeriod = (s: S, fields: F) => ({ ...(s as object), period: info(fields) }) as S & { readonly period: PeriodInfo<F> };
      const inOpen = (m: Marked & { query: Query.Query; logPosition: LogPosition; horizon: LogPosition }, fields: F): Loaded<S & { readonly period: PeriodInfo<F> }> => ({
        state: withPeriod(m.s, fields),
        logPosition: m.logPosition,
        horizon: m.horizon,
        boundary: m.query,
        guard: closingQuery(id, fields)
      });

      const first = yield* read(eventStore, id, target);
      if (first.opened && !first.closed) return inOpen(first, target);

      // The period "now" falls in is not open: find which one is, and turn it.
      const track = yield* eventStore.project(trackingQuery(id), LogPositionNS.zero(), [tracking]);
      const current = track.state;
      if (current !== null && spec.key(current) >= spec.key(target)) {
        // Never turn a period back: a clock behind (another pod) or an opening that landed since the first read. Decide in the period that is open.
        if (spec.key(current) > spec.key(target)) {
          yield* Effect.logWarning(`period: the clock says ${spec.key(target)} but ${spec.key(current)} is already open for ${id}; deciding in ${spec.key(current)}`);
        }
        const open = yield* read(eventStore, id, current);
        if (!open.opened || open.closed) return yield* Effect.die(new Error(`.period: ${spec.key(current)} is open for ${id} by its opening but its own events say otherwise`));
        return inOpen(open, current);
      }
      if (current === null && first.closed) {
        return yield* Effect.die(new Error(`.period: ${spec.key(target)} was closed for ${id} and no period is open; a closed period is not reopened`));
      }

      let carry = first.s;
      let boundary = unionOf(first.query, trackingQuery(id));
      let horizon = LogPositionNS.earliest(first.horizon, track.horizon);
      const prefix: Array<AppendEvent> = [];
      if (current !== null) {
        const old = yield* read(eventStore, id, current);
        carry = old.s;
        boundary = unionOf(boundary, old.query);
        horizon = LogPositionNS.earliest(horizon, old.horizon);
        prefix.push(requireTags(closed(config.close(old.s, context(current))), closed.type));
      }
      const opening = requireTags(opened(config.open(carry, context(target))), opened.type);
      prefix.push(opening);
      const state = openedEntry.apply(first.s, opening.eventData, { event: { type: opening.type, data: opening.eventData, tags: opening.tags } as unknown as StoredEvent, id });
      return { state: withPeriod(state, target), logPosition: horizon, horizon, prefix, boundary } satisfies Loaded<S & { readonly period: PeriodInfo<F> }>;
    });

  return {
    of: ({ id }) => ({
      query: unionOf(queryOf(entries, def.by, id, [], true), trackingQuery(id)),
      handles: eventTypes,
      ignores: ignored,
      bindings: [...new Set([def.by, ...entries.flatMap((e) => e.by ?? [])])],
      load: (eventStore) => load(eventStore, id) as never
    }),
    lifecycleQuery: (id) => queryOf(entries, def.by, id, [], true)
  };
};

export const defineModel = <S, Scope extends object = {}>(def: {
  // Default tag key that binds an event to this model's id (e.g. "wallet_id").
  readonly by: string;
  readonly initial: () => S;
  // Extra tags that narrow the non-lifecycle events to a slice (e.g. a year/month period).
  readonly scope?: (scope: Scope) => Record<string, TagValue>;
}): ModelBuilder<S, Scope> => {
  const build = (entries: ReadonlyArray<OnEntry<S>>, ignored: ReadonlyArray<string> = []): ModelBuilder<S, Scope> => {
    const queryFor = (id: string, scopeTags: ReadonlyArray<Tag.Tag>, lifecycleOnly: boolean): Query.Query => queryOf(entries, def.by, id, scopeTags, lifecycleOnly);

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
        ignored
      );

    return {
      on: (event, apply, opts) => add(event, apply, opts),
      lifecycle: (event, apply) => add(event, apply, { lifecycle: true }),
      lifecycleQuery: (id) => queryFor(id, [], true),
      period: (spec, config) => periodModel(entries, ignored, def, spec, config) as never,
      // a declaration only: the boundary and the fold are untouched
      ignores: (...events) => build(entries, [...new Set([...ignored, ...events.map((e) => e.type)])]),
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
          handles: eventTypes,
          ignores: ignored,
          bindings: [...new Set([def.by, ...entries.flatMap((e) => e.by ?? [])])],
          load: (eventStore) => Effect.map(eventStore.project(query, LogPositionNS.zero(), [projector]), loaded)
        };
      }
    };
  };
  return build([]);
};

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
        // Members with a period bring the events that turn it, the boundary they were read with and the guard of the period they decided in; the whole carries all of them.
        const entriesWithPeriod = Object.entries(members).map(([key, member]) => [key, member, loaded.find(([k]) => k === key)![1]] as const);
        const prefix = loaded.flatMap(([, l]) => l.prefix ?? []);
        const boundary = entriesWithPeriod.some(([, , l]) => l.boundary !== undefined) ? unionOf(...entriesWithPeriod.map(([, m, l]) => l.boundary ?? m.query)) : undefined;
        const guardParts = loaded.map(([, l]) => l.guard).filter((g): g is Query.Query => g !== undefined);
        return {
          state: Object.fromEntries(loaded.map(([key, l]) => [key, l.state])) as never,
          logPosition: horizon,
          horizon,
          ...(prefix.length > 0 ? { prefix } : {}),
          ...(boundary !== undefined ? { boundary } : {}),
          ...(guardParts.length > 0 ? { guard: unionOf(...guardParts) } : {})
        };
      })
  };
};
