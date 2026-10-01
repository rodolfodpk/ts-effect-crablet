import * as Schema from "effect/Schema";
import { DomainError } from "@crablet/commands/Errors";

// The wallet's domain errors: plain typed failures of command handlers, each declaring what KIND of
// refusal it is. The HTTP layer maps each kind to a status and presents
// the error's own fields (WalletApp.ts declares them per command); the domain never mentions a status code.
export class WalletNotFound extends DomainError("WalletNotFound", {
  fields: { walletId: Schema.String },
  kind: "not_found"
}) {}

export class WalletAlreadyExists extends DomainError("WalletAlreadyExists", {
  fields: { walletId: Schema.String },
  kind: "conflict"
}) {}

export class InsufficientFunds extends DomainError("InsufficientFunds", {
  fields: { walletId: Schema.String, currentBalance: Schema.Number, requestedAmount: Schema.Number },
  kind: "invalid"
}) {}

export class InvalidOperation extends DomainError("InvalidOperation", {
  fields: { message: Schema.String },
  kind: "invalid"
}) {}

export class OptimisticLock extends DomainError("OptimisticLock", {
  fields: { message: Schema.String },
  kind: "conflict"
}) {}

export class DuplicateOperation extends DomainError("DuplicateOperation", {
  fields: { message: Schema.String },
  kind: "conflict"
}) {}
