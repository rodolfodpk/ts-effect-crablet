// The wallet's Deposit, Withdraw and TransferMoney with a pause point, for tests of the month rollover (docs/plans/period-rollover.md). They are the real commands' rules (same contract, model, consistency
// and decide). The clock is not a parameter any more: the framework reads the Effect `Clock`, so a test runs a command under `atClock(() => date)`. `afterLoad` runs after the model is loaded and before the
// append - where a command that decided in one month can find, on arriving, that another has turned it.
import { Clock, Effect } from "effect";
import { concurrent, defineCommand, emit, fail } from "@crablet/commands/Command";
import { all } from "@crablet/commands/Model";
import * as Tag from "@crablet/eventstore/Tag";
import { InsufficientFunds, WalletNotFound } from "../../src/domain/errors/WalletErrors.ts";
import { DepositContract, TransferMoneyContract, WithdrawContract } from "../../src/domain/WalletContracts.ts";
import { DepositMade, MoneyTransferred, WalletPeriodModel, WithdrawalMade, periodTags, statementIdOf } from "../../src/domain/WalletModel.ts";
import * as WalletTags from "../../src/domain/WalletTags.ts";

export type Pause = Effect.Effect<void> | undefined;

// Runs `effect` with the Effect clock reading `now()` (called on every read, so a test can move time between attempts).
export const atClock = <A, E, R>(now: () => Date, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Clock.Clock, (base) =>
    Effect.provideService(
      effect,
      Clock.Clock,
      Object.assign(Object.create(base), {
        currentTimeMillisUnsafe: () => now().getTime(),
        currentTimeMillis: Effect.sync(() => now().getTime())
      }) as Clock.Clock
    )
  );

const afterLoadOf = (model: any, pause: Pause) => (pause === undefined ? model : { ...model, load: (es: any) => Effect.tap(model.load(es), () => pause) });

export const pausableDeposit = (afterLoad?: Pause) =>
  defineCommand({
    ...DepositContract,
    model: (c: any) => afterLoadOf(WalletPeriodModel.of({ id: c.walletId }), afterLoad),
    consistency: (c: any) => concurrent({ guard: WalletPeriodModel.lifecycleQuery(c.walletId) }),
    idempotentBy: (c: any) => DepositMade.where({ [WalletTags.DEPOSIT_ID]: c.depositId }),
    decide: (wallet: any, c: any) =>
      wallet.exists ? emit(DepositMade({ ...c, newBalance: wallet.balance + c.amount, depositedAt: new Date().toISOString() }, periodTags(c.walletId, wallet.period))) : fail(new WalletNotFound({ walletId: c.walletId }))
  } as never);

export const pausableWithdraw = (afterLoad?: Pause) =>
  defineCommand({
    ...WithdrawContract,
    model: (c: any) => afterLoadOf(WalletPeriodModel.of({ id: c.walletId }), afterLoad),
    idempotentBy: (c: any) => WithdrawalMade.where({ [WalletTags.WITHDRAWAL_ID]: c.withdrawalId }),
    decide: (wallet: any, c: any) =>
      !wallet.exists
        ? fail(new WalletNotFound({ walletId: c.walletId }))
        : wallet.balance < c.amount
          ? fail(new InsufficientFunds({ walletId: c.walletId, currentBalance: wallet.balance, requestedAmount: c.amount }))
          : emit(WithdrawalMade({ ...c, newBalance: wallet.balance - c.amount, withdrawnAt: new Date().toISOString() }, periodTags(c.walletId, wallet.period)))
  } as never);

export const pausableTransfer = (afterLoad?: Pause) =>
  defineCommand({
    ...TransferMoneyContract,
    model: (c: any) => afterLoadOf(all({ from: WalletPeriodModel.of({ id: c.fromWalletId }), to: WalletPeriodModel.of({ id: c.toWalletId }) }), afterLoad),
    decide: ({ from, to }: any, c: any) =>
      !from.exists
        ? fail(new WalletNotFound({ walletId: c.fromWalletId }))
        : !to.exists
          ? fail(new WalletNotFound({ walletId: c.toWalletId }))
          : from.balance < c.amount
            ? fail(new InsufficientFunds({ walletId: c.fromWalletId, currentBalance: from.balance, requestedAmount: c.amount }))
            : emit(
                MoneyTransferred({ ...c, fromBalance: from.balance - c.amount, toBalance: to.balance + c.amount, transferredAt: new Date().toISOString() }, [
                  Tag.of(WalletTags.YEAR, String(from.period.fields.year)),
                  Tag.of(WalletTags.MONTH, String(from.period.fields.month)),
                  Tag.of(WalletTags.FROM_STATEMENT_ID, statementIdOf(c.fromWalletId, from.period.key)),
                  Tag.of(WalletTags.TO_STATEMENT_ID, statementIdOf(c.toWalletId, to.period.key))
                ])
              )
  } as never);
