// What the page and the lab server say to each other. Both import this file: the server encodes its answers with these Schemas and the page decodes them, so a field one side
// changes and the other does not is a decoding error on the page ("Mismatch"), not a blank cell. It imports no foldkit and no node, so both sides (and the tests) can use it.
import { Schema } from "effect";

// The faults the page can run. `hold` is how long a fault that has an end (a partition, a pause) lasts before it is healed.
export const scenarios = [
  { id: "kill-views-leader", label: "Kill the views leader", description: "Delete the pod that leads the views module, with no grace period. Another worker takes the lock." },
  { id: "kill-automations-leader", label: "Kill the automations leader", description: "The same for the automations module." },
  { id: "kill-outbox-leader", label: "Kill the outbox leader", description: "The same for the outbox module." },
  { id: "kill-worker", label: "Kill a worker", description: "Delete a random worker pod (it may or may not be a leader)." },
  { id: "kill-api", label: "Kill an API pod", description: "Delete a random API pod; commands in flight on it fail, the other pod keeps serving." },
  { id: "rolling-workers", label: "Rolling update of the workers", description: "Restart the workers one at a time, as a deploy would." },
  { id: "partition-leader", label: "Cut the views leader from Postgres", description: "Drop its packets to the database without resetting the connection, for the hold time, then heal. The slow failover: the lock is freed only when Postgres gives up on the connection." },
  { id: "pause-view", label: "Pause a view", description: "Pause one random view through the admin API for the hold time, then resume it. The others keep running; reads of that view wait." }
] as const;
export const ScenarioId = Schema.Literals(scenarios.map((s) => s.id) as unknown as [string, ...string[]]);

export const Pod = Schema.Struct({
  name: Schema.String,
  role: Schema.Literals(["api", "workers", "loadgen", "grafana", "postgres", "other"]),
  phase: Schema.String,
  ready: Schema.Boolean,
  restarts: Schema.Finite,
  node: Schema.String,
  ageSeconds: Schema.Finite
});
export type Pod = typeof Pod.Type;

// The pod that holds each module's leader lock, or null when none does.
export const Leaders = Schema.Struct({ views: Schema.NullOr(Schema.String), automations: Schema.NullOr(Schema.String), outbox: Schema.NullOr(Schema.String) });

export const LogEntry = Schema.Struct({ at: Schema.String, text: Schema.String, ok: Schema.Boolean });

export const Run = Schema.Struct({
  running: Schema.Boolean,
  scenarios: Schema.Array(Schema.String),
  minutes: Schema.Finite,
  intervalSeconds: Schema.Finite,
  holdSeconds: Schema.Finite,
  startedAt: Schema.NullOr(Schema.String),
  endsAt: Schema.NullOr(Schema.String),
  faults: Schema.Finite,
  log: Schema.Array(LogEntry)
});

export const Check = Schema.Struct({
  name: Schema.String,
  // information: a fact worth knowing that is not a pass or a fail
  info: Schema.Boolean,
  ok: Schema.Boolean,
  detail: Schema.String
});
export type Check = typeof Check.Type;
export const Verification = Schema.Struct({
  at: Schema.String,
  ok: Schema.Boolean,
  waitedSeconds: Schema.Finite,
  checks: Schema.Array(Check)
});
export const Verify = Schema.Struct({ running: Schema.Boolean, step: Schema.String, result: Schema.NullOr(Verification) });

// The load generator (a pod in the cluster): whether it runs, how it is set, and the last burst it reported.
export const Load = Schema.Struct({
  running: Schema.Boolean,
  intervalSeconds: Schema.Finite,
  minCommands: Schema.Finite,
  maxCommands: Schema.Finite,
  wallets: Schema.Finite,
  // a burst has been sent and not all of it answered yet
  bursting: Schema.Boolean,
  lastBurst: Schema.NullOr(Schema.String)
});
export type Load = typeof Load.Type;

// How much is happening and how far behind the processors are, as of the last look (null when the admin API did not answer).
export const Pulse = Schema.Struct({
  commandsPerSecond: Schema.Finite,
  eventsPerSecond: Schema.Finite,
  pendingEvents: Schema.NullOr(Schema.Finite),
  behindSeconds: Schema.NullOr(Schema.Finite)
});
export type Pulse = typeof Pulse.Type;

export const State = Schema.Struct({
  // the server's clock (ISO): the page dates what it sees with it, and measures a run's progress against it
  now: Schema.String,
  context: Schema.String,
  pods: Schema.Array(Pod),
  leaders: Leaders,
  run: Run,
  verify: Verify,
  load: Load,
  pulse: Pulse,
  commands: Schema.Finite,
  events: Schema.Finite
});
export type State = typeof State.Type;

export const StartRun = Schema.Struct({
  scenarios: Schema.Array(Schema.String),
  minutes: Schema.Finite,
  intervalSeconds: Schema.Finite,
  holdSeconds: Schema.Finite,
  // verify the data when the run ends
  verifyAfter: Schema.Boolean
});
export type StartRun = typeof StartRun.Type;

export const KillPod = Schema.Struct({ pod: Schema.String });
// Start (on) or pause the generator; the numbers apply when it starts. Changing them while it runs restarts it.
export const SetLoad = Schema.Struct({ on: Schema.Boolean, intervalSeconds: Schema.Finite, minCommands: Schema.Finite, maxCommands: Schema.Finite, wallets: Schema.Finite });
export type SetLoad = typeof SetLoad.Type;
// Empty the database and start again. `confirm` must be true: the page asks first.
export const ResetDatabase = Schema.Struct({ confirm: Schema.Boolean });
export const Ack = Schema.Struct({ ok: Schema.Boolean, text: Schema.String });
