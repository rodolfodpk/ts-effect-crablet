// Story tests drive `update` (Messages in; Model and Commands out); scene tests drive the real `view`. Both run under bun:test; no browser, no server.
import { describe, expect, test } from "bun:test";
import * as AsyncData from "foldkit/asyncData";
import { Scene, Story } from "foldkit/test";
import { FetchState, Message, Send, ServerState, ago, clock, describeProblem, formatDuration, healthOf, init, leaderChanges, logKind, parseLoad, parseRun, update, view, type Model } from "../src/main.ts";
import type { State } from "../src/contract.ts";

expect.extend(Scene.sceneMatchers as never);

const start: Model = init().model;
const state = (over: Partial<State> = {}): State => ({
  now: "2026-10-09T12:00:10.000Z",
  context: "kind-crablet-lab",
  pods: [
    { name: "wallet-api-a", role: "api", phase: "Running", ready: true, restarts: 0, node: "crablet-lab-worker", ageSeconds: 120 },
    { name: "wallet-workers-a", role: "workers", phase: "Running", ready: true, restarts: 0, node: "crablet-lab-worker2", ageSeconds: 120 },
    { name: "postgres-a", role: "postgres", phase: "Running", ready: true, restarts: 0, node: "crablet-lab-control-plane", ageSeconds: 600 }
  ],
  leaders: { views: "wallet-workers-a", automations: "wallet-workers-a", outbox: null },
  run: { running: false, scenarios: [], minutes: 0, intervalSeconds: 0, holdSeconds: 0, startedAt: null, endsAt: null, faults: 0, log: [] },
  verify: { running: false, step: "", result: null },
  pulse: { commandsPerSecond: 12.3, eventsPerSecond: 15, pendingEvents: 40, behindSeconds: 0.4 },
  load: { running: true, intervalSeconds: 5, minCommands: 10, maxCommands: 1000, wallets: 200, bursting: false, lastBurst: "514 commands in 3012 ms" },
  commands: 1200,
  events: 1500,
  ...over
});
// What the server answers to a Send, and to the read of the state that follows it.
const answered = (text = "ok") => [
  Story.Command.resolve(Send, Message.SucceededSend({ ok: true, text })),
  Story.Command.resolve(FetchState, Message.SucceededState({ state: state() }))
];
const shown = (s: State, over: Partial<Model> = {}): Model => ({ ...start, state: ServerState.Success({ data: s }), load: { interval: "5", min: "10", max: "1000", wallets: "200", filled: true }, ...over });

describe("the forms", () => {
  test("the load form becomes a request, or says what is wrong", () => {
    const form = { interval: "5", min: "10", max: "1000", wallets: "200", filled: true };
    expect(parseLoad(form, true)).toEqual({ on: true, intervalSeconds: 5, minCommands: 10, maxCommands: 1000, wallets: 200 });
    expect(parseLoad({ ...form, interval: "0" }, true)).toMatch(/interval/);
    expect(parseLoad({ ...form, min: "50", max: "10" }, true)).toMatch(/smallest burst cannot be larger/);
    expect(parseLoad({ ...form, wallets: "1" }, true)).toMatch(/wallets/);
    expect(parseLoad({ ...form, max: "ten" }, true)).toMatch(/largest/);
  });
  test("the run form needs a fault and sane numbers", () => {
    const form = { selected: ["kill-views-leader"], minutes: "5", interval: "30", hold: "20", verifyAfter: true };
    expect(parseRun(form)).toEqual({ scenarios: ["kill-views-leader"], minutes: 5, intervalSeconds: 30, holdSeconds: 20, verifyAfter: true });
    expect(parseRun({ ...form, selected: [] })).toMatch(/at least one/);
    expect(parseRun({ ...form, minutes: "0" })).toMatch(/Minutes/);
    expect(parseRun({ ...form, interval: "1" })).toMatch(/between faults/);
    expect(parseRun({ ...form, hold: "9999" })).toMatch(/lasts/);
  });
});

describe("what the page notices", () => {
  test("a leader that changed hands is a line with the old and the new pod", () => {
    const before = { views: "a", automations: "a", outbox: "a" };
    expect(leaderChanges(null, before, "2026-10-09T12:00:00.000Z")).toEqual([]);
    expect(leaderChanges(before, { views: "b", automations: "a", outbox: null }, "2026-10-09T12:00:00.000Z").map((c) => c.text)).toEqual(["views: a → b", "outbox: a → nobody"]);
  });
  test("durations and clocks read well", () => {
    expect(formatDuration(42)).toBe("42 s");
    expect(formatDuration(185)).toBe("3 min 05 s");
    expect(formatDuration(7500)).toBe("2 h 05 min");
    expect(clock("2026-10-09T12:34:56.789Z")).toBe("12:34:56");
    expect(describeProblem({ _tag: "Unreachable" })).toMatch(/node examples\/chaos-ui\/server\/server\.ts/);
  });
});

describe("is it healthy", () => {
  test("a system with leaders, ready pods, nothing behind and the load running is healthy, with no reasons", () => {
    expect(healthOf(state({ leaders: { views: "a", automations: "a", outbox: "a" } }))).toEqual({ level: "ok", reasons: [] });
  });
  test("a module with no leader, or a pod that is not ready, needs attention, and says which", () => {
    expect(healthOf(state({ leaders: { views: "a", automations: null, outbox: "a" } }))).toEqual({ level: "bad", reasons: ["nobody leads automations"] });
    const pods = [{ name: "wallet-workers-x", role: "workers" as const, phase: "Running", ready: false, restarts: 0, node: "n", ageSeconds: 1 }];
    expect(healthOf(state({ leaders: { views: "a", automations: "a", outbox: "a" }, pods })).reasons[0]).toMatch(/pod is not ready \(workers-x\)/);
  });
  test("being behind is a warning from 5 s and a problem from 30 s; a paused load and an unanswering admin API are only worth a look", () => {
    const base = { leaders: { views: "a", automations: "a", outbox: "a" } };
    expect(healthOf(state({ ...base, pulse: { commandsPerSecond: 0, eventsPerSecond: 0, pendingEvents: 5, behindSeconds: 8 } })).level).toBe("warn");
    expect(healthOf(state({ ...base, pulse: { commandsPerSecond: 0, eventsPerSecond: 0, pendingEvents: 5, behindSeconds: 45 } })).level).toBe("bad");
    expect(healthOf(state({ ...base, pulse: { commandsPerSecond: 0, eventsPerSecond: 0, pendingEvents: null, behindSeconds: null } })).reasons).toEqual(["the admin API did not answer (it may be busy)"]);
    expect(healthOf(state({ ...base, load: { running: false, intervalSeconds: 5, minCommands: 1, maxCommands: 2, wallets: 2, bursting: false, lastBurst: null } })).reasons).toEqual(["the load is paused"]);
  });
  test("log lines are told apart: what was done, what was undone, and the rest", () => {
    expect(logKind("fault: Kill a worker")).toBe("fault");
    expect(logKind("killed wallet-workers-x (workers)")).toBe("fault");
    expect(logKind("cut wallet-workers-x from Postgres for 20 s (packets dropped)")).toBe("fault");
    expect(logKind("healed wallet-workers-x; another pod led views after 18.0 s")).toBe("heal");
    expect(logKind("run finished")).toBe("heal");
    expect(logKind("no pod leads views right now")).toBe("info");
    expect(ago("2026-10-09T12:00:30.000Z", "2026-10-09T12:00:00.000Z")).toBe("30 s ago");
  });
});

describe("the page over time", () => {
  test("it starts loading and asks the server for the state", () => {
    expect(AsyncData.isLoading(start.state)).toBe(true);
    expect((init().commands ?? []).length).toBe(1);
  });

  test("the state fills the load form once, and a later refresh does not overwrite what is typed; a change of leader is noted", () => {
    Story.story(
      update,
      Story.given<Model>(start),
      Story.message(Message.SucceededState({ state: state() })),
      Story.model((m: Model) => {
        expect(m.load).toEqual({ interval: "5", min: "10", max: "1000", wallets: "200", filled: true });
        expect(m.changes).toEqual([]);
      }),
      Story.message(Message.ChangedLoad({ field: "max", value: "300" })),
      Story.message(Message.SucceededState({ state: state({ leaders: { views: "wallet-workers-b", automations: "wallet-workers-a", outbox: null } }) })),
      Story.model((m: Model) => {
        expect(m.load.max).toBe("300");
        expect(m.changes.map((c) => c.text)).toEqual(["views: wallet-workers-a → wallet-workers-b"]);
      })
    );
  });

  test("starting the run sends the chosen faults; a bad form sends nothing and says why", () => {
    Story.story(update, Story.given<Model>(shown(state())), Story.message(Message.ClickedStartRun()), Story.Command.expectExact(Send({ path: "/api/run", body: JSON.stringify({ scenarios: ["kill-views-leader"], minutes: 5, intervalSeconds: 30, holdSeconds: 20, verifyAfter: true }), label: "Start the run" })), ...answered());
    Story.story(
      update,
      Story.given<Model>(shown(state(), { run: { selected: [], minutes: "5", interval: "30", hold: "20", verifyAfter: true } })),
      Story.message(Message.ClickedStartRun()),
      Story.Command.expectNone(),
      Story.model((m: Model) => expect(m.notice).toEqual({ ok: false, text: "Choose at least one fault." }))
    );
  });

  test("a scenario is chosen and unchosen by its checkbox", () => {
    Story.story(
      update,
      Story.given<Model>(shown(state())),
      Story.message(Message.ToggledScenario({ id: "kill-api" })),
      Story.model((m: Model) => expect(m.run.selected).toEqual(["kill-views-leader", "kill-api"])),
      Story.message(Message.ToggledScenario({ id: "kill-views-leader" })),
      Story.model((m: Model) => expect(m.run.selected).toEqual(["kill-api"]))
    );
  });

  test("clearing the database asks first, and sends only after the yes", () => {
    Story.story(
      update,
      Story.given<Model>(shown(state())),
      Story.message(Message.ClickedClear()),
      Story.Command.expectNone(),
      Story.model((m: Model) => expect(m.confirmingClear).toBe(true)),
      Story.message(Message.CancelledClear()),
      Story.model((m: Model) => expect(m.confirmingClear).toBe(false)),
      Story.message(Message.ClickedClear()),
      Story.message(Message.ConfirmedClear()),
      Story.Command.expectExact(Send({ path: "/api/reset", body: JSON.stringify({ confirm: true }), label: "Clear the database" })),
      ...answered()
    );
  });

  test("the answer of an action is shown as a notice, and the state is read again", () => {
    Story.story(
      update,
      Story.given<Model>(shown(state())),
      Story.message(Message.SucceededSend({ ok: false, text: "a run is already going" })),
      Story.Command.expectExact(FetchState({})),
      Story.Command.resolve(FetchState, Message.SucceededState({ state: state() })),
      Story.model((m: Model) => expect(m.notice).toEqual({ ok: false, text: "a run is already going" }))
    );
  });
});

describe("the page on screen", () => {
  test("a server that is not there is explained, with the command to start it", () => {
    Scene.scene({ update, view }, Scene.given<Model>({ ...start, state: ServerState.Failure({ error: { _tag: "Unreachable" } }) }), (Scene.expect(Scene.role("alert")) as any).toExist());
  });

  test("the leaders, the load, the faults, the pods and the checks are all there", () => {
    Scene.scene(
      { update, view },
      Scene.given<Model>(shown(state())),
      (Scene.expect(Scene.label("Leaders")) as any).toExist(),
      (Scene.expect(Scene.role("button", { name: "Kill wallet-workers-a" })) as any).toExist(),
      (Scene.expect(Scene.role("button", { name: "Kill wallet-api-a" })) as any).toExist(),
      (Scene.expect(Scene.role("button", { name: "Kill postgres-a" })) as any).not.toExist()
    );
  });

  test("a finished verification shows each check with its verdict", () => {
    const result = { at: "2026-10-09T12:00:00.000Z", ok: false, waitedSeconds: 12, checks: [{ name: "The balance view equals the sum of the log", info: false, ok: false, detail: "22 wallets with another balance" }, { name: "No wallet was ever overdrawn", info: false, ok: true, detail: "0 moments" }] };
    Scene.scene({ update, view }, Scene.given<Model>(shown(state({ verify: { running: false, step: "", result } }))), (Scene.expect(Scene.label("Checks")) as any).toExist(), (Scene.expect(Scene.text("1 of 2 checks do not hold.")) as any).toExist());
  });
});
