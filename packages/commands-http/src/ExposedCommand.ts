import type { Command } from "@crablet/commands/Command";

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

export const exposedCommandOf = <T, E = never>(
  command: Command<T, E>,
  mapError?: (error: E) => object | undefined
): ExposedCommand<T, E> => ({ command, mapError });
