import * as Schema from "effect/Schema";
import { defineCommand, emit, fail } from "@crablet/commands/Command";
import { all } from "@crablet/commands/Model";
import * as Tag from "@crablet/eventstore/Tag";
import { InsufficientFunds, WalletNotFound } from "../errors/WalletErrors.ts";
import { TransferMoneyContract } from "../WalletContracts.ts";
import { MoneyTransferred, WalletPeriodModel, statementIdOf } from "../WalletModel.ts";
import * as WalletTags from "../WalletTags.ts";

export type TransferMoneyCommand = Schema.Schema.Type<(typeof TransferMoneyContract)["input"]>;

// Affects two wallets' balances at once, so strict over BOTH wallets' combined boundary: a change to
// either refuses a stale decision. Each wallet resolves its own statement period first (either may
// lazily open one), sequentially because both may append.
export const TransferMoney = defineCommand({
  ...TransferMoneyContract,
  model: (c) => all({ from: WalletPeriodModel.of({ id: c.fromWalletId }), to: WalletPeriodModel.of({ id: c.toWalletId }) }),
  decide: ({ from, to }, c) =>
    !from.exists
      ? fail(new WalletNotFound({ walletId: c.fromWalletId }))
      : !to.exists
        ? fail(new WalletNotFound({ walletId: c.toWalletId }))
        : from.balance < c.amount
          ? fail(new InsufficientFunds({ walletId: c.fromWalletId, currentBalance: from.balance, requestedAmount: c.amount }))
          : emit(
              MoneyTransferred(
                { ...c, fromBalance: from.balance - c.amount, toBalance: to.balance + c.amount, transferredAt: new Date().toISOString() },
                // both wallets share the current period; each side's own statement id is tagged for the views
                [
                  Tag.of(WalletTags.YEAR, String(from.period.fields.year)),
                  Tag.of(WalletTags.MONTH, String(from.period.fields.month)),
                  Tag.of(WalletTags.FROM_STATEMENT_ID, statementIdOf(c.fromWalletId, from.period.key)),
                  Tag.of(WalletTags.TO_STATEMENT_ID, statementIdOf(c.toWalletId, to.period.key))
                ]
              )
            )
});
