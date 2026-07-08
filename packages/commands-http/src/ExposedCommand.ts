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
}

export const exposedCommandOf = <T, E = never>(
  schema: Schema.Schema<T>,
  handler: CommandHandler<T, E>
): ExposedCommand<T, E> => ({ schema, handler });
