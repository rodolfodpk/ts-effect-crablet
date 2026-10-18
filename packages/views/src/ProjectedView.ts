import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import type { DeclaredSelection, EventSelection } from "@crablet/event-poller/EventSelection";
import type { ProcessorRuntimeOverrides } from "@crablet/event-poller/ProcessorRuntimeOverrides";
import { runOp } from "./internal/ViewOpSql.ts";
import { makeTransactionalViewProjector, type ViewProjector } from "./ViewProjector.ts";
import { viewSubscriptionOf, type ViewSubscription } from "./ViewSubscription.ts";
import type { ViewOp, ViewTableDef } from "./ViewTable.ts";

// A view declared as "what each event does to the view's tables" (ADR-0026):
//
//     export const SeatsView = defineView("course-seats-view", { tables: [seats] })
//       .on(CourseDefined,    (d) => seats.insert({ course_id: d.courseId, capacity: d.capacity }, { onConflict: "ignore" }))
//       .on(StudentSubscribed, (d) => seats.update({ course_id: d.courseId }, { add: { subscribers: 1 } }));
//
// The handlers return operations (ViewTable.ts), so the same declaration gives: the projector (decode each event with its own definition, run the
// operations on the given `sql`, in the transaction of the view's cursor), the subscription (the event types handled), the tables the view owns
// (for the drift check and a rebuild) and an in-memory run for tests (ViewMemory.ts). A handler is a pure function from the decoded event to
// operations: it never touches the database.

// What a view needs of an event definition (`defineEvent`'s result satisfies it): typed structurally so this package does not depend on @crablet/commands.
export interface ViewEvent<Data> {
  readonly type: string;
  readonly decodeStored: (event: Pick<StoredEvent, "data" | "position" | "transactionId">) => Effect.Effect<Data, EventDecodingError>;
}

export interface ViewContext {
  readonly event: StoredEvent;
  readonly position: bigint;
  // The value of a tag the event carries (a transfer's `from_statement_id`), if any.
  readonly tag: (key: string) => string | undefined;
}

export type ViewOps = ViewOp | undefined | ReadonlyArray<ViewOp | undefined>;

export interface ProjectedView {
  readonly name: string;
  // The event types a handler was declared for: what the subscription selects.
  readonly handles: ReadonlyArray<string>;
  readonly tables: ReadonlyArray<ViewTableDef>;
  on<Data>(event: ViewEvent<Data>, handle: (data: Data, ctx: ViewContext) => ViewOps): ProjectedView;
  // The operations an event stands for (none when no handler is declared for its type). A payload the event's definition cannot read fails with `EventDecodingError`, never skipped (ADR-0017).
  readonly opsOf: (event: StoredEvent) => Effect.Effect<ReadonlyArray<ViewOp>, EventDecodingError>;
  readonly projector: Effect.Effect<ViewProjector<SqlError | EventDecodingError>, never, SqlClient.SqlClient>;
  // The view's subscription: the event types its handlers are declared for, the selection it was defined with, and `opts` on top.
  readonly subscription: (opts?: Partial<EventSelection> & ProcessorRuntimeOverrides) => ViewSubscription;
}

interface Handler {
  readonly decode: ViewEvent<unknown>["decodeStored"];
  readonly handle: (data: unknown, ctx: ViewContext) => ViewOps;
}

const flatten = (ops: ViewOps): ReadonlyArray<ViewOp> =>
  ops === undefined ? [] : Array.isArray(ops) ? (ops as ReadonlyArray<ViewOp | undefined>).filter((o): o is ViewOp => o !== undefined) : [ops as ViewOp];

const build = (name: string, tables: ReadonlyArray<ViewTableDef>, selection: DeclaredSelection, handlers: ReadonlyMap<string, Handler>): ProjectedView => {
  const opsOf = (event: StoredEvent): Effect.Effect<ReadonlyArray<ViewOp>, EventDecodingError> => {
    const handler = handlers.get(event.type);
    if (handler === undefined) return Effect.succeed([]);
    return Effect.map(handler.decode(event), (data) =>
      flatten(handler.handle(data, { event, position: event.position, tag: (key) => event.tags.find((t) => t.key === key)?.value }))
    );
  };
  const handles = [...handlers.keys()];
  return {
    name,
    handles,
    tables,
    on: (event, handle) => {
      if (handlers.has(event.type)) throw new Error(`view "${name}": a handler for ${event.type} is already declared`);
      return build(name, tables, selection, new Map([...handlers, [event.type, { decode: event.decodeStored as Handler["decode"], handle: handle as Handler["handle"] }]]));
    },
    opsOf,
    projector: makeTransactionalViewProjector<EventDecodingError | SqlError>(name, (event, sql) =>
      Effect.gen(function* () {
        const ops = yield* opsOf(event);
        for (const op of ops) yield* runOp(sql, op);
      })
    ),
    subscription: (opts = {}) => viewSubscriptionOf(name, { ...selection, ...opts, eventTypes: new Set(handles) })
  };
};

// `tables` are the tables the view owns (for the drift check); the rest is what it reads besides its event types (a tag every event must carry, ...).
// Polling and batch settings are not part of it: they are given to the processor, by the view's name.
export const defineView = (name: string, def: { readonly tables: ReadonlyArray<ViewTableDef> } & DeclaredSelection): ProjectedView => {
  const { tables, ...selection } = def;
  return build(name, tables, selection, new Map());
};
