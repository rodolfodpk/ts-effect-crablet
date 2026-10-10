// The wallet's Deposit, Withdraw and TransferMoney with an injectable clock and two pause points, for tests of the month rollover (docs/plans/period-rollover.md). They are the real commands' rules
// (same contract, model, consistency and decide) with `resolveActivePeriod` given a `now` read from `clock()` on every attempt, so a retry after a conflict reads a later clock, as a real clock would.
// `hooks.afterPrepare` runs after the period is resolved and before the model is loaded; `hooks.afterLoad` runs after the model is loaded and before the append.
import { Effect } from "effect";
import { concurrent, defineCommand, emit, fail } from "@crablet/commands/Command";
import { all } from "@crablet/commands/Model";
import * as Tag from "@crablet/eventstore/Tag";
import { InsufficientFunds, WalletNotFound } from "../../src/domain/errors/WalletErrors.ts";
import { DepositContract, TransferMoneyContract, WithdrawContract } from "../../src/domain/WalletContracts.ts";
import { periodTags, resolveActivePeriod } from "../../src/domain/period/WalletStatementPeriodResolver.ts";
import { DepositMade, MoneyTransferred, WalletModel, WithdrawalMade } from "../../src/domain/WalletModel.ts";
import * as WalletTags from "../../src/domain/WalletTags.ts";

export interface Hooks {
  readonly afterPrepare?: Effect.Effect<void>;
  readonly afterLoad?: Effect.Effect<void>;
}
export type Clock = () => Date;

const afterLoadOf = (model: any, hook: Effect.Effect<void> | undefined) =>
  hook === undefined ? model : { ...model, load: (es: any) => Effect.tap(model.load(es), () => hook) };
const prepared = (hooks: Hooks) => (period: any) => (hooks.afterPrepare ? Effect.as(hooks.afterPrepare, period) : Effect.succeed(period));

export const clockedDeposit = (clock: Clock, hooks: Hooks = {}) =>
  defineCommand({
    ...DepositContract,
    prepare: (c: any, es: any) => Effect.flatMap(resolveActivePeriod(es, c.walletId, clock()), prepared(hooks)),
    model: (c: any, period: any) => afterLoadOf(WalletModel.of({ id: c.walletId, year: period.year, month: period.month }), hooks.afterLoad),
    consistency: (c: any) => concurrent({ guard: WalletModel.lifecycleQuery(c.walletId) }),
    idempotentBy: (c: any) => DepositMade.where({ [WalletTags.DEPOSIT_ID]: c.depositId }),
    decide: (wallet: any, c: any, period: any) =>
      wallet.exists ? emit(DepositMade({ ...c, newBalance: wallet.balance + c.amount, depositedAt: clock().toISOString() }, periodTags(period))) : fail(new WalletNotFound({ walletId: c.walletId }))
  } as never);

export const clockedWithdraw = (clock: Clock, hooks: Hooks = {}) =>
  defineCommand({
    ...WithdrawContract,
    prepare: (c: any, es: any) => Effect.flatMap(resolveActivePeriod(es, c.walletId, clock()), prepared(hooks)),
    model: (c: any, period: any) => afterLoadOf(WalletModel.of({ id: c.walletId, year: period.year, month: period.month }), hooks.afterLoad),
    idempotentBy: (c: any) => WithdrawalMade.where({ [WalletTags.WITHDRAWAL_ID]: c.withdrawalId }),
    decide: (wallet: any, c: any, period: any) =>
      !wallet.exists
        ? fail(new WalletNotFound({ walletId: c.walletId }))
        : wallet.balance < c.amount
          ? fail(new InsufficientFunds({ walletId: c.walletId, currentBalance: wallet.balance, requestedAmount: c.amount }))
          : emit(WithdrawalMade({ ...c, newBalance: wallet.balance - c.amount, withdrawnAt: clock().toISOString() }, periodTags(period)))
  } as never);

export const clockedTransfer = (clock: Clock, hooks: Hooks = {}) =>
  defineCommand({
    ...TransferMoneyContract,
    prepare: (c: any, es: any) =>
      Effect.gen(function* () {
        const from = yield* resolveActivePeriod(es, c.fromWalletId, clock());
        const to = yield* resolveActivePeriod(es, c.toWalletId, clock());
        return yield* prepared(hooks)({ from, to });
      }),
    model: (c: any, p: any) =>
      afterLoadOf(
        all({
          from: WalletModel.of({ id: c.fromWalletId, year: p.from.year, month: p.from.month }),
          to: WalletModel.of({ id: c.toWalletId, year: p.to.year, month: p.to.month })
        }),
        hooks.afterLoad
      ),
    decide: ({ from, to }: any, c: any, p: any) =>
      !from.exists
        ? fail(new WalletNotFound({ walletId: c.fromWalletId }))
        : !to.exists
          ? fail(new WalletNotFound({ walletId: c.toWalletId }))
          : from.balance < c.amount
            ? fail(new InsufficientFunds({ walletId: c.fromWalletId, currentBalance: from.balance, requestedAmount: c.amount }))
            : emit(
                MoneyTransferred({ ...c, fromBalance: from.balance - c.amount, toBalance: to.balance + c.amount, transferredAt: clock().toISOString() }, [
                  Tag.of(WalletTags.YEAR, String(p.from.year)),
                  Tag.of(WalletTags.MONTH, String(p.from.month)),
                  Tag.of(WalletTags.FROM_STATEMENT_ID, p.from.statementId),
                  Tag.of(WalletTags.TO_STATEMENT_ID, p.to.statementId)
                ])
              )
  } as never);
