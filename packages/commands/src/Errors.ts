import { Data } from "effect";
import type * as Cause from "effect/Cause";
import type * as Schema from "effect/Schema";
import type { VoidIfEmpty } from "effect/Types";

// Command input failed its schema (wrong shape, out-of-range value, ...). Distinct from a domain
// error: it says the request was malformed, not that a business rule refused it.
export class InvalidInput extends Data.TaggedError("InvalidInput")<{ readonly message: string }> {}

// A neutral category for a domain error. Deliberately NOT an HTTP status: the domain says what
// KIND of refusal this is; a transport layer (commands-http) decides how to present each kind.
//   not_found  - something the command refers to does not exist
//   invalid    - the request is well-formed but a business rule forbids it (e.g. insufficient funds)
//   conflict   - it clashes with current state (e.g. already exists)
//   forbidden  - the caller may not do this
export type ErrorKind = "not_found" | "invalid" | "conflict" | "forbidden";

// Marks an error instance as a declared domain error and carries its kind. A symbol-keyed property,
// so it cannot collide with a domain error's own fields, and a type (`KindedError`) that transports can
// require at compile time.
export const DomainErrorKind: unique symbol = Symbol.for("@crablet/commands/DomainErrorKind");
export interface KindedError {
  readonly [DomainErrorKind]: ErrorKind;
}

// Declare a domain error: a tagged error class (catchable with `Effect.catchTag`) with typed fields,
// plus its `kind` and field schemas as statics, for transports to read.
//
//     class WalletNotFound extends DomainError("WalletNotFound", {
//       fields: { walletId: Schema.String },
//       kind: "not_found"
//     }) {}
//
//     new WalletNotFound({ walletId: "w1" })    // _tag: "WalletNotFound", walletId: "w1"
//     WalletNotFound.kind                        // "not_found"
type FieldValues<F extends Record<string, Schema.Constraint>> = { readonly [K in keyof F]: Schema.Schema.Type<F[K]> };

// The shape `DomainError(...)` returns: a constructor taking the field values, producing a tagged,
// yieldable error carrying them, with `kind` and `fields` as statics. Spelled out (rather than
// inferred from `Data.TaggedError`) because TypeScript cannot `extend` a base class whose instance
// type is a generic mapped type.
export interface DomainErrorClass<Tag extends string, F extends Record<string, Schema.Constraint>> {
  new (args: VoidIfEmpty<FieldValues<F>>): Cause.YieldableError & { readonly _tag: Tag } & FieldValues<F> & KindedError;
  readonly kind: ErrorKind;
  readonly fields: F;
  readonly tag: Tag;
}

export const DomainError = <Tag extends string, F extends Record<string, Schema.Constraint>>(
  tag: Tag,
  spec: { readonly fields: F; readonly kind: ErrorKind }
): DomainErrorClass<Tag, F> => {
  const Base = Data.TaggedError(tag) as unknown as new (args: unknown) => object;
  class DomainErrorImpl extends Base {
    static readonly kind: ErrorKind = spec.kind;
    static readonly fields: F = spec.fields;
    static readonly tag: Tag = tag;
    get [DomainErrorKind](): ErrorKind {
      return spec.kind;
    }
  }
  return DomainErrorImpl as unknown as DomainErrorClass<Tag, F>;
};

// Any class made by `DomainError(...)`, seen from outside: constructible into an error `E`, carrying its
// `kind`, `tag` and field schemas as statics. What a command declares in its `errors: [...]` list.
export interface AnyDomainErrorClass<E = any> {
  new (...args: any[]): E;
  readonly kind: ErrorKind;
  readonly tag: string;
  readonly fields: Record<string, Schema.Top>;
}

// The kind declared by a `DomainError`, or undefined for any other value.
export const kindOf = (error: unknown): ErrorKind | undefined => {
  const kind = (error as Partial<KindedError> | null | undefined)?.[DomainErrorKind];
  return kind === "not_found" || kind === "invalid" || kind === "conflict" || kind === "forbidden" ? kind : undefined;
};
