// The chaos lab page: who leads each module, the load generator, the pods, a run of chosen faults for N minutes, a check that the data is consistent afterwards, and a way to start from an empty database.
// It does nothing by itself: every button is a call to the lab server (server/server.ts), which runs kubectl on your computer. `import type` for types: Node strips types but does not drop imports.
import { Effect, Schema, Stream } from "effect";
import { Http, Subscription } from "foldkit";
import type { Runtime, Update } from "foldkit";
import * as AsyncData from "foldkit/asyncData";
import * as Command from "foldkit/command";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { Problem, problemFromError, sendCall, stateCall } from "./api.ts";
import { Leaders, State, scenarios } from "./contract.ts";
import type { SetLoad, StartRun } from "./contract.ts";

// MODEL

export const ServerState = AsyncData.Schema(State, Problem);

const Notice = Schema.Struct({ ok: Schema.Boolean, text: Schema.String });
const LeaderChange = Schema.Struct({ at: Schema.String, text: Schema.String });

export const Model = Schema.Struct({
  state: ServerState.schema,
  // what the last button did, until the next one
  notice: Schema.NullOr(Notice),
  // The load form is text, so a half-typed number is not lost; it is filled from the server once and then left alone (a refresh must not overwrite what you are typing).
  load: Schema.Struct({ interval: Schema.String, min: Schema.String, max: Schema.String, wallets: Schema.String, filled: Schema.Boolean }),
  run: Schema.Struct({ selected: Schema.Array(Schema.String), minutes: Schema.String, interval: Schema.String, hold: Schema.String, verifyAfter: Schema.Boolean }),
  confirmingClear: Schema.Boolean,
  // the leaders as last seen, and the changes since the page opened
  leaders: Schema.NullOr(Leaders),
  changes: Schema.Array(LeaderChange)
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  Ticked: {},
  SucceededState: { state: State },
  FailedState: { problem: Problem },
  SucceededSend: { ok: Schema.Boolean, text: Schema.String },
  FailedSend: { label: Schema.String, problem: Problem },

  ChangedLoad: { field: Schema.Literals(["interval", "min", "max", "wallets"]), value: Schema.String },
  ClickedStartLoad: {},
  ClickedPauseLoad: {},
  ClickedApplyLoad: {},

  ToggledScenario: { id: Schema.String },
  ChangedRun: { field: Schema.Literals(["minutes", "interval", "hold"]), value: Schema.String },
  ToggledVerifyAfter: {},
  ClickedStartRun: {},
  ClickedStopRun: {},

  ClickedKill: { pod: Schema.String },
  ClickedVerify: {},
  ClickedClear: {},
  ConfirmedClear: {},
  CancelledClear: {}
});
export type Message = typeof Message.Type;

// COMMANDS

export const FetchState = Command.define("FetchState", {
  args: {},
  messages: [Message.SucceededState, Message.FailedState],
  execute: () =>
    stateCall.pipe(
      Effect.map((state) => Message.SucceededState({ state })),
      Effect.catch((error) => Effect.succeed(Message.FailedState({ problem: problemFromError(error) }))),
      Effect.provide(Http.layer)
    )
});

// One call to the server that does something. The server answers with an Ack (ok or not, and a sentence), shown as the notice.
export const Send = Command.define("Send", {
  args: { path: Schema.String, body: Schema.String, label: Schema.String },
  messages: [Message.SucceededSend, Message.FailedSend],
  execute: ({ path, body, label }) =>
    sendCall(path, body).pipe(
      Effect.map((ack) => Message.SucceededSend({ ok: ack.ok, text: ack.text })),
      Effect.catch((error) => Effect.succeed(Message.FailedSend({ label, problem: problemFromError(error) }))),
      Effect.provide(Http.layer)
    )
});

// FORMS: text in, a request or a sentence about what is wrong out

const whole = (text: string): number | null => (/^\s*[0-9]+(\.[0-9]+)?\s*$/.test(text) ? Number(text) : null);

export const parseLoad = (form: Model["load"], on: boolean): SetLoad | string => {
  const intervalSeconds = whole(form.interval);
  const minCommands = whole(form.min);
  const maxCommands = whole(form.max);
  const wallets = whole(form.wallets);
  if (intervalSeconds === null || intervalSeconds < 1 || intervalSeconds > 3600) return "The interval must be a number of seconds from 1 to 3600.";
  if (minCommands === null || minCommands < 1 || minCommands > 5000) return "The smallest burst must be from 1 to 5000 commands.";
  if (maxCommands === null || maxCommands < 1 || maxCommands > 5000) return "The largest burst must be from 1 to 5000 commands.";
  if (minCommands > maxCommands) return "The smallest burst cannot be larger than the largest.";
  if (wallets === null || wallets < 2 || wallets > 5000) return "The number of wallets must be from 2 to 5000.";
  return { on, intervalSeconds, minCommands: Math.floor(minCommands), maxCommands: Math.floor(maxCommands), wallets: Math.floor(wallets) };
};

export const parseRun = (form: Model["run"]): StartRun | string => {
  const minutes = whole(form.minutes);
  const intervalSeconds = whole(form.interval);
  const holdSeconds = whole(form.hold);
  if (form.selected.length === 0) return "Choose at least one fault.";
  if (minutes === null || minutes < 1 || minutes > 240) return "Minutes must be from 1 to 240.";
  if (intervalSeconds === null || intervalSeconds < 5 || intervalSeconds > 600) return "The time between faults must be from 5 to 600 seconds.";
  if (holdSeconds === null || holdSeconds < 5 || holdSeconds > 300) return "How long a cut or a pause lasts must be from 5 to 300 seconds.";
  return { scenarios: form.selected, minutes, intervalSeconds, holdSeconds, verifyAfter: form.verifyAfter };
};

// UPDATE

const send = (model: Model, path: string, payload: unknown, label: string): Update.Return<Model, Message> => ({
  model: { ...model, notice: null },
  commands: [Send({ path, body: JSON.stringify(payload), label })]
});
const failed = (model: Model, text: string): Update.Return<Model, Message> => ({ model: { ...model, notice: { ok: false, text } } });

// Which module changed hands since the last look, in words.
export const leaderChanges = (before: typeof Leaders.Type | null, after: typeof Leaders.Type, at: string): ReadonlyArray<typeof LeaderChange.Type> =>
  before === null
    ? []
    : (["views", "automations", "outbox"] as const).flatMap((module) =>
        before[module] === after[module]
          ? []
          : [{ at, text: `${module}: ${before[module] ?? "nobody"} → ${after[module] ?? "nobody"}` }]
      );

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    Ticked: () => ({ model, commands: [FetchState({})] }),
    SucceededState: ({ state }) => ({
      model: {
        ...model,
        state: ServerState.Success({ data: state }),
        leaders: state.leaders,
        changes: [...leaderChanges(model.leaders, state.leaders, state.now), ...model.changes].slice(0, 12),
        load: model.load.filled
          ? model.load
          : { interval: String(state.load.intervalSeconds), min: String(state.load.minCommands), max: String(state.load.maxCommands), wallets: String(state.load.wallets), filled: true }
      }
    }),
    FailedState: ({ problem }) => ({ model: { ...model, state: ServerState.Failure({ error: problem }) } }),
    SucceededSend: ({ ok, text }) => ({ model: { ...model, notice: { ok, text } }, commands: [FetchState({})] }),
    FailedSend: ({ label, problem }) => ({ model: { ...model, notice: { ok: false, text: `${label}: ${describeProblem(problem)}` } } }),

    ChangedLoad: ({ field, value }) => ({ model: { ...model, load: { ...model.load, [field]: value } } }),
    ClickedStartLoad: () => {
      const request = parseLoad(model.load, true);
      return typeof request === "string" ? failed(model, request) : send(model, "/api/load", request, "Start the load");
    },
    ClickedPauseLoad: () => {
      const request = parseLoad(model.load, false);
      return typeof request === "string" ? failed(model, request) : send(model, "/api/load", request, "Pause the load");
    },
    ClickedApplyLoad: () => {
      const running = AsyncData.isSuccess(model.state) ? model.state.data.load.running : false;
      const request = parseLoad(model.load, running);
      return typeof request === "string" ? failed(model, request) : send(model, "/api/load", request, "Apply the load settings");
    },

    ToggledScenario: ({ id }) => ({
      model: { ...model, run: { ...model.run, selected: model.run.selected.includes(id) ? model.run.selected.filter((s) => s !== id) : [...model.run.selected, id] } }
    }),
    ChangedRun: ({ field, value }) => ({ model: { ...model, run: { ...model.run, [field]: value } } }),
    ToggledVerifyAfter: () => ({ model: { ...model, run: { ...model.run, verifyAfter: !model.run.verifyAfter } } }),
    ClickedStartRun: () => {
      const request = parseRun(model.run);
      return typeof request === "string" ? failed(model, request) : send(model, "/api/run", request, "Start the run");
    },
    ClickedStopRun: () => send(model, "/api/run/stop", {}, "Stop the run"),

    ClickedKill: ({ pod }) => send(model, "/api/kill", { pod }, `Kill ${pod}`),
    ClickedVerify: () => send(model, "/api/verify", {}, "Verify"),
    ClickedClear: () => ({ model: { ...model, confirmingClear: true } }),
    CancelledClear: () => ({ model: { ...model, confirmingClear: false } }),
    ConfirmedClear: () => send({ ...model, confirmingClear: false }, "/api/reset", { confirm: true }, "Clear the database")
  });

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    state: AsyncData.Loading(),
    notice: null,
    load: { interval: "5", min: "10", max: "1000", wallets: "200", filled: false },
    run: { selected: ["kill-views-leader"], minutes: "5", interval: "30", hold: "20", verifyAfter: true },
    confirmingClear: false,
    leaders: null,
    changes: []
  },
  commands: [FetchState({})]
});

// SUBSCRIPTIONS: read the state every two seconds, always

export const refreshEvery = "2 seconds";
export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  refresh: entry({ enabled: Schema.Boolean }, {
    modelToDependencies: () => ({ enabled: true }),
    dependenciesToStream: ({ enabled }) => (enabled ? Stream.tick(refreshEvery).pipe(Stream.map((): Message => Message.Ticked())) : Stream.empty)
  })
}));

// VIEW

export const describeProblem = (problem: Problem): string =>
  problem._tag === "Unreachable"
    ? "The lab server is not reachable. Start it with: node examples/chaos-ui/server/server.ts"
    : `The server's answer does not match the contract: ${problem.detail.replaceAll("\n", " ")}`;

// "42 s", "3 min 05 s", "2 h 10 min"
export const formatDuration = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
};
export const clock = (iso: string): string => iso.slice(11, 19);

type State_ = typeof State.Type;

// IS IT HEALTHY? One look, with the reasons: what an on-call person needs before reading anything else. "bad" is something that is broken now; "warn" is something to watch.
export type Health = { readonly level: "ok" | "warn" | "bad"; readonly reasons: ReadonlyArray<string> };
export const healthOf = (s: State_): Health => {
  const bad: string[] = [];
  const warn: string[] = [];
  for (const [module, pod] of Object.entries(s.leaders)) if (pod === null) bad.push(`nobody leads ${module}`);
  const notReady = s.pods.filter((p) => (p.role === "api" || p.role === "workers") && p.phase !== "Terminating" && !p.ready);
  if (notReady.length > 0) bad.push(`${notReady.length === 1 ? "a pod is" : `${notReady.length} pods are`} not ready (${notReady.map((p) => p.name.replace(/^wallet-/, "")).join(", ")})`);
  if (s.pulse.behindSeconds !== null && s.pulse.behindSeconds >= 30) bad.push(`a processor is ${formatDuration(s.pulse.behindSeconds)} behind`);
  else if (s.pulse.behindSeconds !== null && s.pulse.behindSeconds >= 5) warn.push(`a processor is ${formatDuration(s.pulse.behindSeconds)} behind`);
  if (s.pulse.behindSeconds === null) warn.push("the admin API did not answer (it may be busy)");
  const restarted = s.pods.filter((p) => (p.role === "api" || p.role === "workers") && p.restarts > 0);
  if (restarted.length > 0) warn.push(`${restarted.length === 1 ? "a pod has" : `${restarted.length} pods have`} restarted`);
  if (!s.load.running) warn.push("the load is paused");
  return bad.length > 0 ? { level: "bad", reasons: [...bad, ...warn] } : warn.length > 0 ? { level: "warn", reasons: warn } : { level: "ok", reasons: [] };
};

// How long ago, from the server's clock.
export const ago = (now: string, at: string): string => `${formatDuration((Date.parse(now) - Date.parse(at)) / 1000)} ago`;

// What kind of line a log entry is, for its colour: what was done to the system, what was undone, or the system's answer.
export const logKind = (text: string): "fault" | "heal" | "info" => (/^(fault:|killed|cut |paused|rolling)/.test(text) ? "fault" : /^(healed|resumed|run (finished|stopped|started)|reset)/.test(text) ? "heal" : "info");

const chip = (h: HtmlBuilder<Message>, kind: string, text: string) => h.span([h.Class(`chip ${kind}`)], [h.span([h.Class("dot")], []), text]);

const leaderCard = (h: HtmlBuilder<Message>, module: string, pod: string | null, hint: string, tookOver: string | null) =>
  h.div(
    [h.Class(pod === null ? "leader none" : tookOver === null ? "leader" : "leader fresh")],
    [
      h.div([h.Class("leader-head")], [h.span([h.Class("leader-module")], [module]), ...(tookOver === null ? [] : [h.span([h.Class("took-over")], [`took over ${tookOver}`])])]),
      h.div([h.Class("leader-pod")], [pod ?? "nobody leads"]),
      h.div([h.Class("leader-hint")], [hint])
    ]
  );

const pulseTile = (h: HtmlBuilder<Message>, label: string, value: string, level: "ok" | "warn" | "bad" | "plain" = "plain") =>
  h.div([h.Class(`pulse-tile ${level}`)], [h.div([h.Class("pulse-value")], [value]), h.div([h.Class("pulse-label")], [label])]);

const field = (h: HtmlBuilder<Message>, label: string, input: ReturnType<HtmlBuilder<Message>["input"]>, hint?: string) =>
  h.label([h.Class("field")], [h.span([h.Class("field-label")], [label]), input, ...(hint === undefined ? [] : [h.span([h.Class("field-hint")], [hint])])]);

const numberInput = (h: HtmlBuilder<Message>, label: string, value: string, min: number, max: number, on: (value: string) => Message, hint?: string) =>
  field(h, label, h.input([h.Type("number"), h.Min(String(min)), h.Max(String(max)), h.AriaLabel(label), h.Value(value), h.OnInput(on)]), hint);

const card = (h: HtmlBuilder<Message>, title: string, body: ReadonlyArray<ReturnType<HtmlBuilder<Message>["div"]>>, aside?: ReturnType<HtmlBuilder<Message>["div"]>) =>
  h.section([h.Class("card"), h.AriaLabel(title)], [h.header([h.Class("card-head")], [h.h2([], [title]), ...(aside === undefined ? [] : [aside])]), ...body]);

const loadCard = (model: Model, s: State_, h: HtmlBuilder<Message>) => {
  const load = s.load;
  const status = load.bursting ? chip(h, "busy", "sending a burst") : load.running ? chip(h, "ok", "running") : chip(h, "paused", "paused");
  return card(
    h,
    "Load",
    [
      h.div(
        [h.Class("grid four")],
        [
          numberInput(h, "Seconds between bursts", model.load.interval, 1, 3600, (value) => Message.ChangedLoad({ field: "interval", value })),
          numberInput(h, "Fewest commands", model.load.min, 1, 5000, (value) => Message.ChangedLoad({ field: "min", value })),
          numberInput(h, "Most commands", model.load.max, 1, 5000, (value) => Message.ChangedLoad({ field: "max", value })),
          numberInput(h, "Wallets", model.load.wallets, 2, 5000, (value) => Message.ChangedLoad({ field: "wallets", value }), "more wallets, less contention")
        ]
      ),
      h.div(
        [h.Class("actions")],
        [
          load.running ? h.button([h.Class("btn"), h.OnClick(Message.ClickedPauseLoad())], ["Pause"]) : h.button([h.Class("btn primary"), h.OnClick(Message.ClickedStartLoad())], ["Start"]),
          h.button([h.Class("btn"), h.OnClick(Message.ClickedApplyLoad())], ["Apply settings"]),
          h.span([h.Class("muted")], [load.lastBurst === null ? "no burst yet" : `last burst: ${load.lastBurst}`])
        ]
      ),
      h.p([h.Class("note")], ["Settings change while it runs, with no restart. Each burst sends a random number of commands between the smallest and the largest, all at once."])
    ],
    status
  );
};

const podRole = (role: string) => h_roleLabel[role] ?? role;
const h_roleLabel: Record<string, string> = { api: "API", workers: "worker", loadgen: "load", grafana: "grafana", postgres: "postgres", other: "other" };

const podsCard = (s: State_, h: HtmlBuilder<Message>) =>
  card(
    h,
    "Pods",
    [
      h.div(
        [h.Class("table-wrap")],
        [
          h.table(
            [h.Class("pods"), h.AriaLabel("Pods")],
            [
              h.thead([], [h.tr([], ["Pod", "Role", "State", "Restarts", "Node", "Age", ""].map((title) => h.th([h.Scope("col")], [title])))]),
              h.tbody(
                [],
                s.pods.map((pod) =>
                  h.tr(
                    [h.Class(pod.phase === "Terminating" ? "terminating" : "")],
                    [
                      h.td([h.Class("mono")], [pod.name]),
                      h.td([], [h.span([h.Class(`role ${pod.role}`)], [podRole(pod.role)])]),
                      h.td([], [chip(h, pod.phase === "Running" && pod.ready ? "ok" : pod.phase === "Terminating" ? "paused" : "bad", pod.phase === "Running" && !pod.ready ? "not ready" : pod.phase.toLowerCase())]),
                      h.td([h.Class("num")], [String(pod.restarts)]),
                      h.td([h.Class("mono muted")], [pod.node.replace("crablet-lab-", "")]),
                      h.td([h.Class("num muted")], [formatDuration(pod.ageSeconds)]),
                      h.td([h.Class("actions-cell")], pod.role === "api" || pod.role === "workers" ? [h.button([h.Class("btn small danger"), h.AriaLabel(`Kill ${pod.name}`), h.OnClick(Message.ClickedKill({ pod: pod.name }))], ["Kill"])] : [])
                    ]
                  )
                )
              )
            ]
          )
        ]
      )
    ],
    h.span([h.Class("muted")], [`${s.pods.length} pods`])
  );

const runCard = (model: Model, s: State_, h: HtmlBuilder<Message>) => {
  const run = s.run;
  const progress = (() => {
    if (!run.running || run.startedAt === null || run.endsAt === null) return 0;
    const total = Date.parse(run.endsAt) - Date.parse(run.startedAt);
    return total <= 0 ? 0 : Math.min(100, Math.max(0, ((Date.parse(s.now) - Date.parse(run.startedAt)) / total) * 100));
  })();
  const remaining = run.running && run.endsAt !== null ? (Date.parse(run.endsAt) - Date.parse(s.now)) / 1000 : 0;
  return card(
    h,
    "Chaos run",
    [
      h.div(
        [h.Class("scenarios"), h.AriaLabel("Faults")],
        scenarios.map((scenario) =>
          h.label(
            [h.Class(model.run.selected.includes(scenario.id) ? "scenario on" : "scenario")],
            [
              h.input([h.Type("checkbox"), h.AriaLabel(scenario.label), h.Checked(model.run.selected.includes(scenario.id)), h.OnClick(Message.ToggledScenario({ id: scenario.id })), ...(run.running ? [h.Disabled(true)] : [])]),
              h.span([h.Class("scenario-text")], [h.span([h.Class("scenario-label")], [scenario.label]), h.span([h.Class("scenario-desc")], [scenario.description])])
            ]
          )
        )
      ),
      h.div(
        [h.Class("grid three")],
        [
          numberInput(h, "Run for (minutes)", model.run.minutes, 1, 240, (value) => Message.ChangedRun({ field: "minutes", value })),
          numberInput(h, "Fault every (seconds)", model.run.interval, 5, 600, (value) => Message.ChangedRun({ field: "interval", value }), "a random one of those chosen"),
          numberInput(h, "Cut or pause lasts (seconds)", model.run.hold, 5, 300, (value) => Message.ChangedRun({ field: "hold", value }))
        ]
      ),
      h.label(
        [h.Class("check")],
        [h.input([h.Type("checkbox"), h.AriaLabel("Verify when the run ends"), h.Checked(model.run.verifyAfter), h.OnClick(Message.ToggledVerifyAfter())]), "Verify the data when the run ends"]
      ),
      h.div(
        [h.Class("actions")],
        [
          run.running ? h.button([h.Class("btn danger"), h.OnClick(Message.ClickedStopRun())], ["Stop the run"]) : h.button([h.Class("btn primary"), h.OnClick(Message.ClickedStartRun())], ["Start the run"]),
          ...(run.running ? [h.span([h.Class("muted")], [`${run.faults} faults so far, ${formatDuration(remaining)} left`])] : [])
        ]
      ),
      ...(run.running ? [h.div([h.Class("progress"), h.AriaLabel("Run progress")], [h.div([h.Class("progress-bar"), h.Style({ width: `${progress.toFixed(1)}%` })], [])])] : [])
    ],
    run.running ? chip(h, "busy", "running") : chip(h, "paused", "idle")
  );
};

const logCard = (s: State_, model: Model, h: HtmlBuilder<Message>) =>
  card(
    h,
    "What happened",
    [
      ...(model.changes.length === 0
        ? []
        : [h.div([h.Class("changes")], [h.div([h.Class("changes-title")], ["Leader changes"]), ...model.changes.map((c) => h.div([h.Class("change")], [h.span([h.Class("time")], [clock(c.at)]), h.span([], [c.text])]))])]),
      s.run.log.length === 0
        ? h.p([h.Class("muted")], ["Nothing yet. Start a run, or kill a pod above."])
        : h.ul(
            [h.Class("log"), h.AriaLabel("Log")],
            [...s.run.log].reverse().map((entry) => h.li([h.Class(`log-line ${logKind(entry.text)}${entry.ok ? "" : " bad"}`)], [h.span([h.Class("time"), h.Title(entry.at)], [`${clock(entry.at)} · ${ago(s.now, entry.at)}`]), h.span([], [entry.text])]))
          )
    ]
  );

const verifyCard = (s: State_, h: HtmlBuilder<Message>) => {
  const v = s.verify;
  const result = v.result;
  return card(
    h,
    "Is the data consistent?",
    [
      h.p([h.Class("note")], ["Pauses the load, waits for every processor to catch up, then compares the event log with what was built from it: balances, duplicates, overdrafts, notifications, the audit, the leaders."]),
      h.div([h.Class("actions")], [h.button([h.Class("btn primary"), h.Disabled(v.running), h.OnClick(Message.ClickedVerify())], [v.running ? "Working..." : result === null ? "Verify now" : "Verify again"]), ...(v.running ? [h.span([h.Class("muted")], [v.step])] : [])]),
      ...(result === null
        ? []
        : [
            h.div(
              [h.Class(result.ok ? "verdict ok" : "verdict bad")],
              [
                h.span([], [result.ok ? "Everything that must hold, holds." : `${result.checks.filter((c) => !c.info && !c.ok).length} of ${result.checks.filter((c) => !c.info).length} checks do not hold.`]),
                h.span([h.Class("verdict-time")], [`checked at ${clock(result.at)} (${ago(s.now, result.at)}), after ${formatDuration(result.waitedSeconds)}`])
              ]
            ),
            h.ul(
              [h.Class("checks"), h.AriaLabel("Checks")],
              // what does not hold first, then what does, then what is only information
              [...result.checks].sort((a, b) => Number(a.info) - Number(b.info) || Number(a.ok) - Number(b.ok)).map((check) =>
                h.li([h.Class(check.info ? "check-row info" : check.ok ? "check-row ok" : "check-row bad")], [h.span([h.Class("badge")], [check.info ? "INFO" : check.ok ? "PASS" : "FAIL"]), h.span([h.Class("check-text")], [h.span([h.Class("check-name")], [check.name]), h.span([h.Class("check-detail")], [check.detail])])])
              )
            )
          ])
    ]
  );
};

const dangerCard = (model: Model, h: HtmlBuilder<Message>) =>
  card(
    h,
    "Start from zero",
    [
      h.p([h.Class("note")], ["Empties the log, the commands, the views and the processors' progress, restarts the positions, and has the load open new wallets. The schema stays. Grafana keeps its history."]),
      model.confirmingClear
        ? h.div([h.Class("confirm"), h.Role("alertdialog"), h.AriaLabel("Confirm clearing the database")], [h.p([], ["Delete all the data in the lab database?"]), h.div([h.Class("actions")], [h.button([h.Class("btn danger"), h.OnClick(Message.ConfirmedClear())], ["Yes, clear it"]), h.button([h.Class("btn"), h.OnClick(Message.CancelledClear())], ["Cancel"])])])
        : h.div([h.Class("actions")], [h.button([h.Class("btn danger"), h.OnClick(Message.ClickedClear())], ["Clear the database"])])
    ]
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Chaos lab",
  body: h.main(
    [],
    [
      h.header(
        [h.Class("page-head")],
        [
          h.div([], [h.h1([], ["Chaos lab"]), h.p([h.Class("muted")], ["Break the wallet's pods on purpose and see who takes over, whether anything is lost, and that the data is still consistent."])]),
          h.nav(
            [h.Class("links"), h.AriaLabel("Other pages of the lab")],
            [
              h.a([h.Href("http://localhost:3000/d/crablet-overview/crablet?orgId=1&from=now-15m&to=now&refresh=5s&var-fresh=20"), h.Target("_blank"), h.Rel("noreferrer")], ["Grafana ↗"]),
              h.a([h.Href("http://localhost:5173"), h.Target("_blank"), h.Rel("noreferrer")], ["Processors ↗"]),
              h.a([h.Href("http://localhost:8081/api/wallets"), h.Target("_blank"), h.Rel("noreferrer")], ["Wallets ↗"]),
              ...(AsyncData.isSuccess(model.state) ? [h.span([h.Class("context")], [model.state.data.context])] : [])
            ]
          )
        ]
      ),
      ...(AsyncData.isSuccess(model.state)
        ? (() => {
            const health = healthOf(model.state.data);
            return [h.div([h.Class(`banner ${health.level}`), h.Role("status")], [h.strong([], [health.level === "ok" ? "Healthy" : health.level === "warn" ? "Worth watching" : "Needs attention"]), health.reasons.length === 0 ? " every module has a leader, every pod is ready, the processors are caught up" : `: ${health.reasons.join("; ")}`])];
          })()
        : []),
      ...(model.notice === null ? [] : [h.p([h.Class(model.notice.ok ? "notice" : "notice bad"), h.Role("status")], [model.notice.text])]),
      AsyncData.match(model.state, {
        onIdle: () => h.p([h.Class("muted")], [""]),
        onLoading: () => h.p([h.Class("muted")], ["Loading..."]),
        onFailure: (problem) => h.p([h.Class("notice bad"), h.Role("alert")], [describeProblem(problem)]),
        onRefreshing: (s) => content(model, s, h),
        onStale: ({ data }) => content(model, data, h),
        onSuccess: (s) => content(model, s, h)
      })
    ]
  )
});

const content = (model: Model, s: State_, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("stack")],
    [
      h.div(
        [h.Class("leaders"), h.AriaLabel("Leaders")],
        (
          [["views", "Views", "builds the read tables"], ["automations", "Automations", "reacts to events"], ["outbox", "Outbox", "publishes events"]] as const
        ).map(([key, title, hint]) => {
          const change = model.changes.find((c) => c.text.startsWith(`${key}:`));
          const recent = change !== undefined && Date.parse(s.now) - Date.parse(change.at) < 120_000;
          return leaderCard(h, title, s.leaders[key], hint, recent ? ago(s.now, change.at) : null);
        })
      ),
      h.div(
        [h.Class("pulse"), h.AriaLabel("Right now")],
        [
          pulseTile(h, "commands per second", s.pulse.commandsPerSecond.toFixed(1)),
          pulseTile(h, "events per second", s.pulse.eventsPerSecond.toFixed(1)),
          pulseTile(h, "events waiting for processors", s.pulse.pendingEvents === null ? "?" : s.pulse.pendingEvents.toLocaleString("en"), s.pulse.pendingEvents === null ? "plain" : s.pulse.pendingEvents > 5000 ? "bad" : s.pulse.pendingEvents > 500 ? "warn" : "ok"),
          pulseTile(h, "slowest processor behind by", s.pulse.behindSeconds === null ? "?" : formatDuration(s.pulse.behindSeconds), s.pulse.behindSeconds === null ? "plain" : s.pulse.behindSeconds >= 30 ? "bad" : s.pulse.behindSeconds >= 5 ? "warn" : "ok"),
          pulseTile(h, "commands in the log", s.commands.toLocaleString("en")),
          pulseTile(h, "events in the log", s.events.toLocaleString("en"))
        ]
      ),
      loadCard(model, s, h),
      h.div([h.Class("two")], [runCard(model, s, h), logCard(s, model, h)]),
      podsCard(s, h),
      verifyCard(s, h),
      dangerCard(model, h)
    ]
  );
