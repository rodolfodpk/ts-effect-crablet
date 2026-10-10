import * as Schema from "effect/Schema";
import { defineCommand, emit, fail } from "@crablet/commands/Command";
import { InsufficientFunds, WalletNotFound } from "../errors/WalletErrors.ts";
import { WithdrawContract } from "../WalletContracts.ts";
import { WalletPeriodModel, WithdrawalMade, periodTags } from "../WalletModel.ts";
import * as WalletTags from "../WalletTags.ts";

export type WithdrawCommand = Schema.Schema.Type<(typeof WithdrawContract)["input"]>;

// Order-sensitive (a real balance check), so strict: it fails if anything in the wallet's period changed
// since it was read. And idempotent on the withdrawal id: on a retry the balance has already been
// reduced, so re-running the balance check would wrongly say "insufficient funds" - the idempotency check
// runs first and reports "already done".
export const Withdraw = defineCommand({
  ...WithdrawContract,
  model: (c) => WalletPeriodModel.of({ id: c.walletId }),
  idempotentBy: (c) => WithdrawalMade.where({ [WalletTags.WITHDRAWAL_ID]: c.withdrawalId }),
  decide: (wallet, c, _prepared, { now }) =>
    !wallet.exists
      ? fail(new WalletNotFound({ walletId: c.walletId }))
      : wallet.balance < c.amount
        ? fail(new InsufficientFunds({ walletId: c.walletId, currentBalance: wallet.balance, requestedAmount: c.amount }))
        : emit(WithdrawalMade({ ...c, newBalance: wallet.balance - c.amount, withdrawnAt: now.toISOString() }, periodTags(c.walletId, wallet.period)))
});
