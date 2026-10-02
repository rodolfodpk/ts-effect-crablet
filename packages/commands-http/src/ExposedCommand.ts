import type { Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import type { Command } from "@crablet/commands/Command";
import type { AnyDomainErrorClass, InvalidInput, KindedError } from "@crablet/commands/Errors";
import type { Conflict, Duplicate } from "@crablet/eventstore/AppendErrors";

// What the REST command API exposes: a flat, app-supplied map name -> ExposedCommand (there is no
// auto-discovery anywhere, see ADR-0008); each entry becomes its own route, `POST {basePath}/{name}`. An
// entry is a defined command (Command.ts) - it brings its own input schema (the request body), validation,
// handler, conflict retry, idempotency policy and the domain error classes it declares (`errors`), which the
// API presents by their kind and documents in the API description.
//
// `I` and `Es` are the command's input Schema and its declared error classes, kept at the type level (see `Command`) so
// the API's static type can name each command's payload and problems; they default to the erased types.
export interface ExposedCommand<
  T,
  E = never,
  I extends Schema.Constraint = Schema.Constraint,
  Es extends ReadonlyArray<AnyDomainErrorClass> = ReadonlyArray<AnyDomainErrorClass>
> {
  readonly command: Command<T, E, I, Es>;
}

// Every error a command can fail with must be something the API knows how to present: a declared
// domain error (its KIND picks the HTTP status; `defineCommand` already requires it to be declared), or one of
// the framework's own errors (input validation, a stale decision, a repeated operation, a database failure).
// Anything else - a plain string, say, or an untagged class - is a compile error here: it could only ever
// surface as a generic 500.
export type Presentable = KindedError | Conflict | Duplicate | SqlError | InvalidInput;

export const exposedCommandOf = <T, E extends Presentable, I extends Schema.Constraint, Es extends ReadonlyArray<AnyDomainErrorClass>>(
  command: Command<T, E, I, Es>
): ExposedCommand<T, E, I, Es> => ({ command });
