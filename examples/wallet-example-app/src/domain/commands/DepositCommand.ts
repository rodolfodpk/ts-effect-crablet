import * as Schema from "effect/Schema";
import { concurrent, defineCommand, emit, fail } from "@crablet/commands/Command";
import { WalletNotFound } from "../errors/WalletErrors.ts";
import { DepositContract } from "../WalletContracts.ts";
import { resolveActivePeriod, periodTags } from "../period/WalletStatementPeriodResolver.ts";
import { DepositMade, WalletModel } from "../WalletModel.ts";
import * as WalletTags from "../WalletTags.ts";

export type DepositCommand = Schema.Schema.Type<(typeof DepositContract)["input"]>;

// Deposits commute with each other - two concurrent deposits do not conflict - but a concurrent wallet
// close still does (the lifecycle guard), and a repeated deposit id is an idempotent success.
export const Deposit = defineCommand({
  ...DepositContract,
  prepare: (c, es) => resolveActivePeriod(es, c.walletId),
  model: (c, period) => WalletModel.of({ id: c.walletId, year: period.year, month: period.month }),
  consistency: (c) => concurrent({ guard: WalletModel.lifecycleQuery(c.walletId) }),
  idempotentBy: (c) => DepositMade.where({ [WalletTags.DEPOSIT_ID]: c.depositId }),
  decide: (wallet, c, period) =>
    wallet.exists
      ? emit(DepositMade({ ...c, newBalance: wallet.balance + c.amount, depositedAt: new Date().toISOString() }, periodTags(period)))
      : fail(new WalletNotFound({ walletId: c.walletId }))
});
