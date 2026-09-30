import type { SqlError } from "effect/sql/SqlError";
import type { Command } from "@crablet/commands/Command";
import type { InvalidInput, KindedError } from "@crablet/commands/Errors";
import type { Conflict, Duplicate } from "@crablet/eventstore/AppendErrors";

// What the REST command API exposes: a flat, app-supplied map commandType -> ExposedCommand (there is
// no auto-discovery anywhere, see ADR-0008). An entry is a defined command (Command.ts) - it brings its
// own input validation, handler, conflict retry and idempotency policy - plus an optional hook to
// present the command's own domain errors.
//
// `mapError` runs BEFORE CommandApiLive.ts's generic terminal catch-all (which otherwise maps anything
// unrecognized to a 500). Return an app-owned, RFC 7807-shaped plain object (its own Schema.Class,
// declared on the combined HttpApi via `makeCommandApiGroup`'s `extraErrors` parameter) to surface this
// command's domain errors (e.g. "wallet not found" -> 404) with real detail; return `undefined` to fall
// through to the generic mapping. Typed as `object`, not a specific ProblemDetail union - each app
// defines its own error shapes, the same type-erasure pragmatism the heterogeneous registry already
// accepts. Method-shorthand syntax (not an arrow-typed property) deliberately: TypeScript checks
// method-shorthand parameters bivariantly, which is what makes a concrete
// ExposedCommand<T, ConcreteE> assignable into the heterogeneous ExposedCommand<any, any> map; an
// arrow-typed property would be checked contravariantly and reject that assignment.
export interface ExposedCommand<T, E = never> {
  readonly command: Command<T, E>;
  mapError?(error: E): object | undefined;
}

// Every error a command can fail with must be something the API knows how to present: a declared
// domain error (its KIND picks the HTTP status), or one of the framework's own errors (input validation,
// a stale decision, a repeated operation, a database failure). Anything else - a plain string, say, or
// an untagged class - is a compile error unless the caller supplies `mapError` to present it.
export type Presentable = KindedError | Conflict | Duplicate | SqlError | InvalidInput;

export function exposedCommandOf<T, E extends Presentable = never>(command: Command<T, E>): ExposedCommand<T, E>;
export function exposedCommandOf<T, E>(
  command: Command<T, E>,
  mapError: (error: E) => object | undefined
): ExposedCommand<T, E>;
export function exposedCommandOf<T, E>(
  command: Command<T, E>,
  mapError?: (error: E) => object | undefined
): ExposedCommand<T, E> {
  return { command, mapError };
}
