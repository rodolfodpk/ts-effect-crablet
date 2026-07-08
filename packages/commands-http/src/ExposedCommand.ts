import * as Schema from "effect/Schema";
import type { CommandHandler } from "@crablet/commands";

// TS-idiomatic replacement for Java's two-tier reflection registry
// (DiscoveredCommandRegistry + CommandApiExposedCommands allowlist, built via
// CommandTypeResolver's reflection over CommandHandler's generic parameter + Jackson
// @JsonSubTypes). This port has no auto-discovery anywhere (ADR-0008) and commands are plain
// objects, not classes with polymorphism annotations - so both Java tiers collapse into one flat,
// app-supplied map: commandType (string) -> { schema, handler }. There is no Java-style "known but
// not exposed" 404 case - anything not in this map is simply unknown (400).
export interface ExposedCommand<T, E = never> {
  readonly schema: Schema.Schema<T>;
  readonly handler: CommandHandler<T, E>;
  // Runs *before* CommandApiLive.ts's generic terminal catch-all (which otherwise maps anything
  // unrecognized to a 500). Return an app-owned, RFC 7807-shaped plain object (its own
  // Schema.Class, `.addError()`'d onto the app's own combined HttpApi via
  // `makeCommandApiGroup`'s `extraErrors` parameter) to surface this command's own domain errors
  // (e.g. "wallet not found" -> 404) with real detail; return `undefined` to fall through to the
  // generic mapping. Deliberately typed as `object`, not a specific ProblemDetail union - each app
  // defines its own domain error shapes, same type-erasure pragmatism this registry's `<any, any>`
  // storage already accepts. Method-shorthand syntax (not an arrow-typed property) deliberately -
  // TypeScript checks method-shorthand parameters bivariantly, which is what makes a concrete
  // ExposedCommand<T, ConcreteE> assignable into the heterogeneous ExposedCommand<any, any> map;
  // an arrow-typed property here would be checked contravariantly and reject that assignment.
  mapError?(error: E): object | undefined;
}

export const exposedCommandOf = <T, E = never>(
  schema: Schema.Schema<T>,
  handler: CommandHandler<T, E>,
  mapError?: (error: E) => object | undefined
): ExposedCommand<T, E> => ({ schema, handler, mapError });
