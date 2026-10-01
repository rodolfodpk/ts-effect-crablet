import { Context, Duration, Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import { CommandAuditStore } from "@crablet/eventstore/CommandAuditStore";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import type { Command } from "./Command.ts";
import { redact } from "./Personal.ts";

// The command audit: one row in `crablet_commands` for every command that APPENDED events, written in the command's own
// transaction. Because the row's `transaction_id` is the transaction that wrote the events, it answers "which request
// caused this event?"; and because it is the same transaction, a command that fails or rolls back leaves no row.
//
// What it stores is a privacy decision, so it is minimal by default:
//   "redacted" (default) - the command's input with every field marked `personal(...)` replaced by "[redacted]"
//   "none"               - no input at all: the command's type, id, time and metadata only
//   "full"               - the whole input, as received (an explicit opt-in: it copies personal data into this table)
//   "off"                - no audit row at all
// Idempotent repeats and no-ops appended nothing and record nothing. Without authentication the framework cannot say WHO
// issued a command: a caller that knows can set an actor (`withActor`), which is recorded in the metadata.
// The table is not the source of truth, so rows can be deleted: see `purgeCommandAudit` / `startAuditRetention`.

export type AuditPayload = "redacted" | "none" | "full" | "off";

export interface AuditConfig {
  readonly payload: AuditPayload;
}

// Set once for the application by `Crablet.layer(pg, { audit })`; a `Context.Reference` so it needs no new required
// service (the default applies when nothing sets it) and can be overridden for one effect with `Effect.provideService`.
export const AuditConfigRef = Context.Reference<AuditConfig>("crablet/AuditConfig", { defaultValue: () => ({ payload: "redacted" }) });

// The caller of a command, when the app knows it. Recorded in the audit metadata. Never taken from an HTTP header by the
// framework (a header can be forged): the app sets it from its own authentication.
const ActorRef = Context.Reference<string | null>("crablet/CommandActor", { defaultValue: () => null });
export const withActor =
  (actor: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, ActorRef, actor);

// JSON for the audit row. Inputs are plain data, but a bigint must not break the command: it is written as a string.
const toJson = (value: unknown): string => JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));

// Records the command that has just appended events. Called inside the command's transaction.
export const recordCommand = (command: Command<any, any>, input: unknown): Effect.Effect<void, SqlError, CommandAuditStore> =>
  Effect.gen(function* () {
    const config = yield* AuditConfigRef;
    if (config.payload === "off") return;
    const data = config.payload === "full" ? input : config.payload === "none" ? {} : redact(command.input as never, input);
    const audit = yield* CommandAuditStore;
    const correlationId = yield* CorrelationContext.correlationId;
    const actor = yield* ActorRef;
    yield* audit.record({
      type: command.name,
      dataJson: toJson(data),
      metadataJson: toJson({ correlationId, actor }),
      occurredAt: new Date()
    });
  });

// Deletes audit rows older than `olderThan` (events are untouched). Returns how many rows went.
export const purgeCommandAudit = (options: { readonly olderThan: Duration.Input }): Effect.Effect<number, SqlError, CommandAuditStore> =>
  Effect.gen(function* () {
    const audit = yield* CommandAuditStore;
    return yield* audit.purge(new Date(Date.now() - Duration.toMillis(Duration.fromInputUnsafe(options.olderThan))));
  });

// For apps without `pg_cron`: purges every `every`, forever, in a detached fiber (interrupt the returned fiber to stop it).
// A failed purge is logged and tried again at the next tick. Off by default: nothing starts it unless the app does.
export const startAuditRetention = (options: { readonly olderThan: Duration.Input; readonly every: Duration.Input }) =>
  Effect.forkDetach(
    Effect.forever(
      Effect.andThen(
        Effect.catchCause(purgeCommandAudit(options), (cause) => Effect.logError("command audit retention failed", cause)),
        Effect.sleep(options.every)
      )
    )
  );
