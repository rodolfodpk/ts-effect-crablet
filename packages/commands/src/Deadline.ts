// A deadline: a command to run once a time has passed (ADR-0043). `decide` returns one with the rest of its decision, so it exists exactly when the
// decision that set it does:
//
//     emit(StudentSubscribed(c), deadline(ReleaseUnpaidSubscription, { courseId, studentId }, { at: DateTime.add(now, { days: 3 }) }))
//
// A deadline is an event in the log (`crablet.DeadlineScheduled`), and so is its firing (`crablet.DeadlineFired`). The append that stores one also
// writes it into `crablet_deadlines`, which the deadlines processor (`@crablet/automations/Deadlines`) reads by time; a test fires what is due with
// `Scenario.fireDue`. A deadline always fires: its command's `decide` reads the model and answers `noop` when it no longer matters.
import type { DateTime } from "effect";
import * as Schema from "effect/Schema";
import type { StoredEvent } from "@crablet/eventstore";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import { formatMarker } from "@crablet/eventstore/Marker";
import type { Command } from "./Command.ts";
import { IdempotencyMismatch, kindOf } from "./Errors.ts";
import { defineEvent, Instant } from "./Event.ts";
import type { ExecutionResult } from "./ExecutionResult.ts";
import { hasPersonalData } from "./Personal.ts";

// No tags: an append locks each (type, tag) pair of its events, so a shared tag would make every append that sets a deadline wait on one lock; and an
// entity tag would put the deadline in that entity's models. Nothing reads deadlines by tag: `crablet_deadlines` is their index.
// The input is stored encoded by its command's schema, as an event's payload is.
export const DeadlineScheduled = defineEvent("crablet.DeadlineScheduled", {
  schema: Schema.Struct({ command: Schema.String, input: Schema.Unknown, dueAt: Instant }),
  tags: () => ({})
});

export const DeadlineOutcome = Schema.Literals(["appended", "noop", "failed"]);
export type DeadlineOutcome = typeof DeadlineOutcome.Type;

// How a deadline ended, caused by it (`causation_id` is the deadline's position). `reason`: a noop's reason, or a domain error's tag. `marker`: where
// the command's write ended, or for a noop the earlier write it pointed at (`formatMarker`; `waitUntilProcessed(view, parseMarker(marker))` waits until
// a view shows the deadline's effect); null for a failure, or a noop with nothing to point at. Absent in a firing stored before it was recorded.
export const DeadlineFired = defineEvent("crablet.DeadlineFired", {
  schema: Schema.Struct({
    deadlinePosition: Schema.String,
    outcome: DeadlineOutcome,
    reason: Schema.NullOr(Schema.String),
    marker: Schema.optionalKey(Schema.NullOr(Schema.String))
  }),
  tags: () => ({})
});

// What firing one deadline did: what `Scenario.fireDue` returns for each.
export interface FiredDeadline {
  readonly deadlinePosition: bigint;
  readonly command: string;
  readonly outcome: DeadlineOutcome;
  readonly reason: string | null;
  // As the firing records it (`DeadlineFired`'s marker).
  readonly marker: string | null;
  // The events the command appended; empty for a noop or a failure.
  readonly events: ReadonlyArray<StoredEvent>;
}

// Why a command cannot be a deadline's, or undefined. A deadline can fire twice (a crash between the command and the record of its firing), so its
// command must recognise a repeat; and its input is stored inside a framework event, where a `personal(...)` mark would be lost.
const refusal = (command: Command<any, any>): string | undefined =>
  !command.idempotent
    ? `deadline for command "${command.name}": the command has no idempotentBy. A deadline can fire twice, so its command must say how to tell that the work is already done.`
    : hasPersonalData(command.input as never)
      ? `deadline for command "${command.name}": its input has a field marked personal(...). A deadline's input is stored in a framework event, where it cannot be masked or erased: give it ids.`
      : undefined;

// The commands deadlines may name, by name: what the deadlines processor and `Scenario.fireDue` are given. Refuses a command `deadline` would refuse,
// and two commands with one name.
export const checkDeadlineCommands = (commands: ReadonlyArray<Command<any, any>>): ReadonlyMap<string, Command<any, any>> => {
  const byName = new Map<string, Command<any, any>>();
  for (const command of commands) {
    const problem = refusal(command);
    if (problem !== undefined) throw new Error(problem);
    if (byName.has(command.name)) throw new Error(`deadline commands: "${command.name}" is given twice`);
    byName.set(command.name, command);
  }
  return byName;
};

// A deadline to append with the decision: `command` runs with `input` at or after `at`. The input is typed by the command's schema.
export const deadline = <In, Err, I extends Schema.Constraint>(command: Command<In, Err, I>, input: In, options: { readonly at: DateTime.Utc }): AppendEvent => {
  const problem = refusal(command);
  if (problem !== undefined) throw new Error(problem);
  const encoded = Schema.encodeUnknownSync(command.input as unknown as Schema.Codec<unknown, unknown>)(input);
  return DeadlineScheduled({ command: command.name, input: encoded, dueAt: options.at });
};

// How a firing ended: what `crablet.DeadlineFired` records.
export interface Firing {
  readonly outcome: DeadlineOutcome;
  readonly reason: string | null;
  readonly marker: string | null;
}

// How a command's run ends a deadline: appended, or a noop with its reason; with the result's marker.
export const outcomeOfResult = (result: ExecutionResult): Firing => {
  const marker = result.marker === null ? null : formatMarker(result.marker);
  return result.wasIdempotent ? { outcome: "noop", reason: result.reason, marker } : { outcome: "appended", reason: null, marker };
};

// A failure that is the command's answer, not a fault: a domain error, or a key used by a different request. The deadline is done (`failed`, with the
// error's tag). Anything else (the database, a conflict that ran out of retries) is a fault: undefined, and the firing is retried.
export const outcomeOfFailure = (error: unknown): Firing | undefined =>
  kindOf(error) !== undefined || error instanceof IdempotencyMismatch ? { outcome: "failed", reason: (error as { _tag: string })._tag, marker: null } : undefined;
