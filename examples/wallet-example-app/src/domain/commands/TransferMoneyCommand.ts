import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { defineCommand, emit, fail } from "@crablet/commands/Command";
import { all } from "@crablet/commands/Model";
import * as Tag from "@crablet/eventstore/Tag";
import { InsufficientFunds, WalletNotFound } from "../errors/WalletErrors.ts";
import { resolveActivePeriod } from "../period/WalletStatementPeriodResolver.ts";
import { Positive } from "../WalletInputs.ts";
import { MoneyTransferred, WalletModel } from "../WalletModel.ts";
import * as WalletTags from "../WalletTags.ts";

const input = Schema.Struct({
  transferId: Schema.String,
  fromWalletId: Schema.String,
  toWalletId: Schema.String,
  amount: Positive,
  description: Schema.String
}).pipe(Schema.check(Schema.makeFilter((c) => c.fromWalletId !== c.toWalletId || "fromWalletId and toWalletId must differ")));
export type TransferMoneyCommand = Schema.Schema.Type<typeof input>;

// Affects two wallets' balances at once, so strict over BOTH wallets' combined boundary: a change to
// either refuses a stale decision. Each wallet resolves its own statement period first (either may
// lazily open one), sequentially because both may append.
export const TransferMoney = defineCommand({
  name: "transfer_money",
  input,
  prepare: (c, es) =>
    Effect.gen(function* () {
      const from = yield* resolveActivePeriod(es, c.fromWalletId);
      const to = yield* resolveActivePeriod(es, c.toWalletId);
      return { from, to };
    }),
  model: (c, p) =>
    all({
      from: WalletModel.of({ id: c.fromWalletId, year: p.from.year, month: p.from.month }),
      to: WalletModel.of({ id: c.toWalletId, year: p.to.year, month: p.to.month })
    }),
  decide: ({ from, to }, c, p) =>
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
                  Tag.of(WalletTags.YEAR, String(p.from.year)),
                  Tag.of(WalletTags.MONTH, String(p.from.month)),
                  Tag.of(WalletTags.FROM_STATEMENT_ID, p.from.statementId),
                  Tag.of(WalletTags.TO_STATEMENT_ID, p.to.statementId)
                ]
              )
            )
});
