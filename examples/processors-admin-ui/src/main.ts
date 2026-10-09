// The processors page: list the background processors of a Crablet application and pause, resume or reset one.
//
// It is not tied to any application. The wire format (routes, response Schemas, the problems) comes from @crablet/processors-http through ./api.ts, and a processor's `kind`
// and `id` are shown as the application named them. `import type` for types: Node strips types but does not drop imports, and the tests and the end-to-end check
// import this file without a DOM.
import { Effect, Schema, Stream } from "effect";
import { Http, Subscription } from "foldkit";
import type { Runtime, Update } from "foldkit";
import * as AsyncData from "foldkit/asyncData";
import * as Command from "foldkit/command";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { Problem, ProcessorInfo, actCall, listCall, problemFromError } from "./api.ts";

// MODEL

export const Processors = AsyncData.Schema(Schema.Array(ProcessorInfo), Problem);

const Target = Schema.Struct({ kind: Schema.String, id: Schema.String });
const ActionName = Schema.Literals(["pause", "resume", "reset"]);
const Notice = Schema.Struct({ ok: Schema.Boolean, text: Schema.String });

export const Model = Schema.Struct({
  // What the person is typing, and the token in use once they connected. The token is kept in memory only.
  tokenInput: Schema.String,
  token: Schema.NullOr(Schema.String),
  processors: Processors.schema,
  // An action that has been sent and not answered: its buttons wait.
  acting: Schema.NullOr(Schema.Struct({ ...Target.fields, action: ActionName })),
  // A reset that was asked for and is waiting for a yes (it restarts a processor, so it asks).
  confirmingReset: Schema.NullOr(Target),
  // What the last action did, until the next one.
  notice: Schema.NullOr(Notice),
  autoRefresh: Schema.Boolean
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ChangedToken: { value: Schema.String },
  SubmittedToken: {},
  ClickedRefresh: {},
  ToggledAutoRefresh: {},
  // From the refresh timer (see `subscriptions`).
  Ticked: {},
  SucceededList: { processors: Schema.Array(ProcessorInfo) },
  FailedList: { problem: Problem },

  ClickedPause: { kind: Schema.String, id: Schema.String },
  ClickedResume: { kind: Schema.String, id: Schema.String },
  ClickedReset: { kind: Schema.String, id: Schema.String },
  ConfirmedReset: {},
  CancelledReset: {},
  SucceededAction: { action: ActionName, kind: Schema.String, id: Schema.String, status: Schema.String },
  FailedAction: { action: ActionName, kind: Schema.String, id: Schema.String, problem: Problem }
});
export type Message = typeof Message.Type;

// COMMANDS: each runs one call and ends in a Succeeded or a Failed Message. A refusal is not an exception: it is a `Problem` the update function matches on.

export const FetchProcessors = Command.define("FetchProcessors", {
  args: { token: Schema.String },
  messages: [Message.SucceededList, Message.FailedList],
  execute: ({ token }) =>
    listCall(token).pipe(
      Effect.map((processors) => Message.SucceededList({ processors })),
      Effect.catch((error) => Effect.succeed(Message.FailedList({ problem: problemFromError(error) }))),
      Effect.provide(Http.layer)
    )
});

// #region command
export const ActOnProcessor = Command.define("ActOnProcessor", {
  args: { token: Schema.String, action: ActionName, kind: Schema.String, id: Schema.String },
  messages: [Message.SucceededAction, Message.FailedAction],
  execute: ({ token, action, kind, id }) =>
    actCall(token, action, kind, id).pipe(
      Effect.map((result) => Message.SucceededAction({ action, kind, id, status: result.status })),
      Effect.catch((error) => Effect.succeed(Message.FailedAction({ action, kind, id, problem: problemFromError(error) }))),
      Effect.provide(Http.layer)
    )
});
// #endregion command

// UPDATE

const isBlank = (value: string): boolean => value.trim() === "";
const same = (a: { readonly kind: string; readonly id: string }, b: { readonly kind: string; readonly id: string }): boolean => a.kind === b.kind && a.id === b.id;

// What an action did, in the page's words.
export const describeAction = (action: "pause" | "resume" | "reset", id: string, status: string): string => {
  switch (action) {
    case "pause":
      return `Paused ${id}: it handles nothing until it is resumed.`;
    case "resume":
      return `Resumed ${id}: it carries on from its cursor.`;
    case "reset":
      return `Reset ${id}: its error count is cleared and it is ${status}. Its cursor did not move.`;
  }
};

// The first load shows "Loading"; a refresh keeps what is on screen until the new list arrives.
export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ChangedToken: ({ value }) => ({ model: { ...model, tokenInput: value } }),
    SubmittedToken: () =>
      isBlank(model.tokenInput)
        ? { model }
        : {
            model: { ...model, token: model.tokenInput.trim(), tokenInput: "", processors: AsyncData.Loading(), notice: null, confirmingReset: null, acting: null },
            commands: [FetchProcessors({ token: model.tokenInput.trim() })]
          },
    ClickedRefresh: () => (model.token === null ? { model } : { model, commands: [FetchProcessors({ token: model.token })] }),
    ToggledAutoRefresh: () => ({ model: { ...model, autoRefresh: !model.autoRefresh } }),
    Ticked: () => (model.token === null || model.acting !== null ? { model } : { model, commands: [FetchProcessors({ token: model.token })] }),
    SucceededList: ({ processors }) => ({ model: { ...model, processors: Processors.Success({ data: processors }) } }),
    // A refused token ends the session: the page asks for another instead of retrying with one the application said no to.
    FailedList: ({ problem }) => ({
      model: problem._tag === "Unauthorized" ? { ...model, token: null, processors: AsyncData.Idle(), notice: null, confirmingReset: null } : { ...model, processors: Processors.Failure({ error: problem }) }
    }),

    ClickedPause: ({ kind, id }) => act(model, "pause", kind, id),
    ClickedResume: ({ kind, id }) => act(model, "resume", kind, id),
    ClickedReset: ({ kind, id }) => ({ model: { ...model, confirmingReset: { kind, id } } }),
    ConfirmedReset: () => (model.confirmingReset === null ? { model } : act({ ...model, confirmingReset: null }, "reset", model.confirmingReset.kind, model.confirmingReset.id)),
    CancelledReset: () => ({ model: { ...model, confirmingReset: null } }),
    SucceededAction: ({ action, id, status }) => ({
      model: { ...model, acting: null, notice: { ok: true, text: describeAction(action, id, status) } },
      commands: model.token === null ? [] : [FetchProcessors({ token: model.token })]
    }),
    FailedAction: ({ action, id, problem }) =>
      problem._tag === "Unauthorized"
        ? { model: { ...model, acting: null, token: null, processors: AsyncData.Idle(), notice: null } }
        : {
            model: { ...model, acting: null, notice: { ok: false, text: `Could not ${action} ${id}: ${describeProblem(problem)}` } },
            commands: model.token === null ? [] : [FetchProcessors({ token: model.token })]
          }
  });

function act(model: Model, action: "pause" | "resume" | "reset", kind: string, id: string): Update.Return<Model, Message> {
  if (model.token === null || model.acting !== null) return { model };
  return { model: { ...model, acting: { kind, id, action }, notice: null }, commands: [ActOnProcessor({ token: model.token, action, kind, id })] };
}

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { tokenInput: "", token: null, processors: AsyncData.Idle(), acting: null, confirmingReset: null, notice: null, autoRefresh: true }
});

// SUBSCRIPTIONS

// #region subscription
// While connected and not in the middle of an action, read the list again every few seconds.
export const refreshEvery = "5 seconds";
export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  refresh: entry(
    { enabled: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ enabled: model.token !== null && model.autoRefresh }),
      dependenciesToStream: ({ enabled }) => (enabled ? Stream.tick(refreshEvery).pipe(Stream.map((): Message => Message.Ticked())) : Stream.empty)
    }
  )
}));
// #endregion subscription

// VIEW

export const describeProblem = (problem: Problem): string => {
  switch (problem._tag) {
    case "Unauthorized":
      return "The application refused this token.";
    case "NotFound":
      return problem.detail;
    case "Mismatch":
      return `That does not match the API definition: ${problem.detail.replaceAll("\n", " ")}`;
    case "Unreachable":
      return "The application could not be reached.";
  }
};

// "12 s", "3 min", "2 h": how long the first waiting event has waited.
export const formatAge = (seconds: number): string => {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
};

// What waits for a processor: nothing, or how many events (a count that stopped at its cap says "at least") and how long the first has waited.
export const formatWaiting = (p: Pick<ProcessorInfo, "pendingEvents" | "pendingCapped" | "oldestPendingSeconds">): string => {
  if (p.pendingEvents === null) return "unknown";
  if (p.pendingEvents === 0) return "nothing";
  const count = `${p.pendingCapped ? "at least " : ""}${p.pendingEvents.toLocaleString("en")}`;
  return p.oldestPendingSeconds === null ? count : `${count}, oldest ${formatAge(p.oldestPendingSeconds)}`;
};

// Which buttons a processor gets: a running one can be paused, a paused one resumed, and one that failed (or has errors) reset.
export const actionsFor = (p: Pick<ProcessorInfo, "status" | "errorCount">): ReadonlyArray<"pause" | "resume" | "reset"> => [
  ...(p.status === "ACTIVE" ? (["pause"] as const) : []),
  ...(p.status === "PAUSED" ? (["resume"] as const) : []),
  ...(p.status === "FAILED" || (p.errorCount ?? 0) > 0 ? (["reset"] as const) : [])
];

const row = (p: ProcessorInfo, model: Model, h: HtmlBuilder<Message>) => {
  const busy = model.acting !== null;
  const button = (action: "pause" | "resume" | "reset") => {
    const label = action === "pause" ? "Pause" : action === "resume" ? "Resume" : "Reset";
    const message =
      action === "pause" ? Message.ClickedPause({ kind: p.kind, id: p.id }) : action === "resume" ? Message.ClickedResume({ kind: p.kind, id: p.id }) : Message.ClickedReset({ kind: p.kind, id: p.id });
    return h.button([h.Class(action), h.AriaLabel(`${label} ${p.id}`), h.OnClick(message), ...(busy ? [h.Disabled(true)] : [])], [label]);
  };
  return h.tr(
    [h.Class(p.status === "FAILED" ? "failed" : p.status === "PAUSED" ? "paused" : "")],
    [
      h.td([], [h.div([h.Class("kind")], [p.kind]), h.div([h.Class("id")], [p.id]), ...(p.description === null ? [] : [h.div([h.Class("desc")], [p.description])])]),
      h.td([], [h.span([h.Class(`badge ${p.status}`)], [p.status]), ...(p.backedOff ? [h.div([h.Class("muted")], ["backed off"])] : [])]),
      h.td(
        [],
        [
          h.div([], [p.errorCount === null ? "no progress row yet" : p.errorCount === 0 ? "none" : `${p.errorCount} in a row`]),
          // Reset clears the count, not the text: an error with a zero count is history, and is shown as such.
          ...(p.lastError === null ? [] : [h.div([h.Class((p.errorCount ?? 0) > 0 ? "last-error" : "last-error old")], [p.lastError])]),
          ...(p.lastError !== null && (p.errorCount ?? 0) === 0 ? [h.div([h.Class("muted")], ["the last error, from before it was reset or recovered"])] : [])
        ]
      ),
      h.td([], [formatWaiting(p)]),
      h.td([h.Class("num")], [p.cursorPosition ?? ""]),
      h.td([h.Class("actions")], actionsFor(p).map(button))
    ]
  );
};

const table = (processors: ReadonlyArray<ProcessorInfo>, model: Model, h: HtmlBuilder<Message>) =>
  processors.length === 0
    ? h.p([h.Class("muted")], ["The application reports no processors."])
    : h.div(
        [],
        [
          // how many are in each state, at a glance
          h.div(
            [h.Class("summary"), h.AriaLabel("Processors by status")],
            (["ACTIVE", "PAUSED", "FAILED"] as const)
              .map((status) => ({ status, count: processors.filter((p) => p.status === status).length }))
              .filter(({ status, count }) => count > 0 || status === "ACTIVE")
              .map(({ status, count }) => h.span([h.Class(`chip ${status}`)], [h.span([h.Class("dot")], []), h.strong([], [String(count)]), ` ${status.toLowerCase()}`]))
          ),
          h.div(
            [h.Class("card")],
            [
              h.table(
                [h.Class("processors"), h.AriaLabel("Processors")],
                [
                  h.thead([], [h.tr([], ["Processor", "Status", "Failures", "Waiting", "Cursor", ""].map((title) => h.th([h.Scope("col")], [title])))]),
                  h.tbody([], processors.map((p) => row(p, model, h)))
                ]
              )
            ]
          )
        ]
      );

const listView = (model: Model, h: HtmlBuilder<Message>) =>
  AsyncData.match(model.processors, {
    onIdle: () => h.p([h.Class("muted")], [""]),
    onLoading: () => h.p([h.Class("muted")], ["Loading processors..."]),
    onRefreshing: (data) => table(data, model, h),
    onFailure: (problem) => h.p([h.Class("result error"), h.Role("alert")], [describeProblem(problem)]),
    onStale: ({ data }) => table(data, model, h),
    onSuccess: (data) => table(data, model, h)
  });

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Processors",
  body: h.main(
    [],
    [
      h.h1([], ["Processors"]),
      h.p(
        [h.Class("muted")],
        ["The background processors of a Crablet application: what each is doing, and pause, resume or reset one. The token is kept in this page's memory only."]
      ),

      ...(model.token === null
        ? [
            h.form(
              [h.OnSubmit(Message.SubmittedToken()), h.AriaLabel("Connect form")],
              [
                h.input([h.Type("password"), h.AriaLabel("Admin token"), h.Placeholder("Admin bearer token"), h.Value(model.tokenInput), h.OnInput((value) => Message.ChangedToken({ value }))]),
                h.button([h.Type("submit"), h.Class("primary")], ["Connect"])
              ]
            )
          ]
        : [
            h.div(
              [h.Class("toolbar")],
              [
                h.button([h.OnClick(Message.ClickedRefresh())], ["Refresh"]),
                h.label(
                  [],
                  [h.input([h.Type("checkbox"), h.AriaLabel("Refresh every few seconds"), h.Checked(model.autoRefresh), h.OnClick(Message.ToggledAutoRefresh())]), `Refresh every ${refreshEvery}`]
                )
              ]
            ),
            ...(model.notice === null ? [] : [h.p([h.Class(model.notice.ok ? "result" : "result error"), h.Role("status")], [model.notice.text])]),
            ...(model.confirmingReset === null
              ? []
              : [
                  h.div(
                    [h.Class("confirm"), h.Role("alertdialog"), h.AriaLabel("Confirm reset")],
                    [
                      h.p([], [`Reset ${model.confirmingReset.id}? This clears its error count and restarts it. It does not move its cursor, so it carries on from where it stopped.`]),
                      h.button([h.OnClick(Message.ConfirmedReset())], ["Reset"]),
                      h.button([h.OnClick(Message.CancelledReset())], ["Cancel"])
                    ]
                  )
                ]),
            listView(model, h),
            h.p(
              [h.Class("field-note")],
              ["Waiting counts the events a processor selects that come after its cursor (up to 100 000), and how long the first has waited. A paused or failed processor does not move its cursor."]
            )
          ])
    ]
  )
});
