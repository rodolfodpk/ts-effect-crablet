import type * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import type { Command } from "@crablet/commands/Command";
import type { ErrorKind, InvalidInput } from "@crablet/commands/Errors";
import type { Conflict, Duplicate } from "@crablet/eventstore/AppendErrors";

// What the REST command API exposes: a flat, app-supplied map name -> ExposedCommand (there is no
// auto-discovery anywhere, see ADR-0008); each entry becomes its own route, `POST {basePath}/{name}`. An
// entry is a defined command (Command.ts) - it brings its own input schema (the request body), validation,
// handler, conflict retry and idempotency policy - plus the domain errors it can fail with, which the API
// presents by their kind and documents in the API description.
export interface ExposedCommand<T, E = never> {
  readonly command: Command<T, E>;
  // The domain error classes this command is documented to fail with (empty when it has none).
  readonly errors: ReadonlyArray<DomainErrorClass<any>>;
}

// A class made by `DomainError(...)`: constructible, and carrying its `kind` and field schemas as statics.
export interface DomainErrorClass<E> {
  new (...args: any[]): E;
  readonly kind: ErrorKind;
  readonly tag: string;
  readonly fields: Record<string, Schema.Top>;
}

type FrameworkError = Conflict | Duplicate | SqlError | InvalidInput;

// The declared classes must cover every DOMAIN error the command can fail with; extra classes are allowed.
// When one is missing, the error message names it (`missingErrorClasses: InsufficientFunds`).
type Covers<E, Es extends ReadonlyArray<DomainErrorClass<any>>> = [Exclude<E, FrameworkError>] extends [
  InstanceType<Es[number]>
]
  ? unknown
  : { readonly missingErrorClasses: Exclude<E, FrameworkError | InstanceType<Es[number]>> };

// Expose a command. Declare the domain errors it can fail with: they are presented by their kind (the kind
// picks the HTTP status) and documented in the API description. `errors: [WalletNotFound, InsufficientFunds]`;
// leaving one out is a compile error. A command that can only fail with the framework's own errors (invalid
// input, a stale decision, a repeated operation, a database failure) needs no declaration.
export function exposedCommandOf<T, E extends FrameworkError>(command: Command<T, E>): ExposedCommand<T, E>;
export function exposedCommandOf<T, E, const Es extends ReadonlyArray<DomainErrorClass<any>>>(
  command: Command<T, E>,
  options: { readonly errors: Es } & Covers<E, Es>
): ExposedCommand<T, E>;
export function exposedCommandOf<T, E>(
  command: Command<T, E>,
  options?: { readonly errors: ReadonlyArray<DomainErrorClass<any>> }
): ExposedCommand<T, E> {
  return { command, errors: options?.errors ?? [] };
}
