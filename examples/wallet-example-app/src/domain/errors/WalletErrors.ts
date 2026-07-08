import { Data } from "effect";

// Port of com.crablet.examples.wallet.exceptions.* - plain typed command-handler failures, mapped
// to HTTP by the wallet app's own ExposedCommand.mapError hooks (api/WalletProblems.ts), not by
// commands-http itself. Same Data.TaggedError pattern EventStore.ts's DCBViolation.ts primer
// establishes for this whole codebase.
export class WalletNotFound extends Data.TaggedError("WalletNotFound")<{
  readonly walletId: string;
}> {}

export class WalletAlreadyExists extends Data.TaggedError("WalletAlreadyExists")<{
  readonly walletId: string;
}> {}

export class InsufficientFunds extends Data.TaggedError("InsufficientFunds")<{
  readonly walletId: string;
  readonly currentBalance: number;
  readonly requestedAmount: number;
}> {}

export class InvalidOperation extends Data.TaggedError("InvalidOperation")<{
  readonly message: string;
}> {}

export class OptimisticLock extends Data.TaggedError("OptimisticLock")<{
  readonly message: string;
}> {}

export class DuplicateOperation extends Data.TaggedError("DuplicateOperation")<{
  readonly message: string;
}> {}
