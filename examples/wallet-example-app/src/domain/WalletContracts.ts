// The PUBLIC part of the wallet's five write commands: their names, their input Schemas and the domain errors they can fail with.
// Nothing here knows how a decision is made (the models, the statement periods, `decide`: see commands/*.ts), so this module is what
// the HTTP API is declared from and what a browser could import. Keep server-only imports out of it.
import * as Schema from "effect/Schema";
import { commandContract } from "@crablet/commands/Contract";
import { personal } from "@crablet/commands/Personal";
import { InsufficientFunds, WalletNotFound } from "./errors/WalletErrors.ts";
import { NonBlank, NonNegative, Positive } from "./WalletInputs.ts";

export const OpenWalletContract = commandContract({
  name: "open_wallet",
  input: Schema.Struct({ walletId: NonBlank, owner: personal(NonBlank), initialBalance: NonNegative })
});

export const DepositContract = commandContract({
  name: "deposit",
  errors: [WalletNotFound],
  input: Schema.Struct({ depositId: Schema.String, walletId: Schema.String, amount: Positive, description: Schema.String })
});

export const WithdrawContract = commandContract({
  name: "withdraw",
  errors: [WalletNotFound, InsufficientFunds],
  input: Schema.Struct({ withdrawalId: Schema.String, walletId: Schema.String, amount: Positive, description: Schema.String })
});

export const TransferMoneyContract = commandContract({
  name: "transfer_money",
  errors: [WalletNotFound, InsufficientFunds],
  input: Schema.Struct({
    transferId: Schema.String,
    fromWalletId: Schema.String,
    toWalletId: Schema.String,
    amount: Positive,
    description: Schema.String
  }).pipe(Schema.check(Schema.makeFilter((c) => c.fromWalletId !== c.toWalletId || "fromWalletId and toWalletId must differ")))
});

export const CloseWalletContract = commandContract({
  name: "close_wallet",
  errors: [WalletNotFound],
  input: Schema.Struct({ walletId: Schema.String })
});

// The wallet's public write API, in route order. SendWelcomeNotification is deliberately not here: it is an automation-triggered
// internal command, not a public write API, so it has no contract.
export const walletContracts = [OpenWalletContract, DepositContract, WithdrawContract, TransferMoneyContract, CloseWalletContract];
