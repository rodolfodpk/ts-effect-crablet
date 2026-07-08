import { Effect } from "effect";
import { EventStore } from "@crablet/eventstore";
import * as StreamPositionNS from "@crablet/eventstore/StreamPosition";
import * as Tag from "@crablet/eventstore/Tag";
import type { SqlError } from "@effect/sql/SqlError";
import type { ConcurrencyException } from "@crablet/eventstore/DCBViolation";
import type { CommandHandler } from "@crablet/commands";
import * as CD from "@crablet/commands/CommandDecision";
import * as WalletTags from "../WalletTags.ts";
import * as WalletEvents from "../events/WalletEvents.ts";
import * as WalletQueryPatterns from "../WalletQueryPatterns.ts";
import { walletBalanceProjector, hasSufficientFunds } from "../WalletBalanceProjector.ts";
import { resolveActivePeriod } from "../period/WalletStatementPeriodResolver.ts";
import { WalletNotFound, InsufficientFunds, InvalidOperation } from "../errors/WalletErrors.ts";

export interface TransferMoneyCommand {
  readonly transferId: string;
  readonly fromWalletId: string;
  readonly toWalletId: string;
  readonly amount: number;
  readonly description: string;
}

// Port of com.crablet.examples.wallet.commands.TransferMoneyCommandHandler. Order-sensitive
// (affects two wallets' balances at once) - NonCommutative over both wallets' combined
// period-scoped decision model (WalletQueryPatterns.transferPeriodDecisionModel), validating
// existence + sufficient funds for both sides before a single non-commutative append.
export const transferMoneyCommandHandler: CommandHandler<
  TransferMoneyCommand,
  WalletNotFound | InsufficientFunds | InvalidOperation | SqlError | ConcurrencyException
> = (command) =>
  Effect.gen(function* () {
    if (command.amount <= 0) return yield* Effect.fail(new InvalidOperation({ message: "amount must be positive" }));
    if (command.fromWalletId === command.toWalletId) {
      return yield* Effect.fail(new InvalidOperation({ message: "fromWalletId and toWalletId must differ" }));
    }

    const eventStore = yield* EventStore;

    // Both wallets are period-resolved independently - each may be in a different lazily-opened
    // statement (e.g. one wallet already touched this month, the other hasn't) - but both share
    // the *same* current calendar month/year by construction (resolveActivePeriod always resolves
    // "now"), so the combined decision model below stays internally consistent.
    const fromPeriod = yield* resolveActivePeriod(eventStore, command.fromWalletId);
    const toPeriod = yield* resolveActivePeriod(eventStore, command.toWalletId);

    const decisionModel = WalletQueryPatterns.transferPeriodDecisionModel(
      command.fromWalletId,
      command.toWalletId,
      fromPeriod.year,
      fromPeriod.month
    );
    const projection = yield* eventStore.project(decisionModel, StreamPositionNS.zero(), [walletBalanceProjector]);

    // walletBalanceProjector folds one shared state across BOTH wallets' events, which would
    // conflate their balances - project each wallet's own period-scoped query separately instead
    // for the actual balance figures, reusing the already-resolved periods above.
    const fromProjection = yield* eventStore.project(
      WalletQueryPatterns.singleWalletActivePeriodDecisionModel(command.fromWalletId, fromPeriod.year, fromPeriod.month),
      StreamPositionNS.zero(),
      [walletBalanceProjector]
    );
    const toProjection = yield* eventStore.project(
      WalletQueryPatterns.singleWalletActivePeriodDecisionModel(command.toWalletId, toPeriod.year, toPeriod.month),
      StreamPositionNS.zero(),
      [walletBalanceProjector]
    );

    if (!fromProjection.state.exists) return yield* Effect.fail(new WalletNotFound({ walletId: command.fromWalletId }));
    if (!toProjection.state.exists) return yield* Effect.fail(new WalletNotFound({ walletId: command.toWalletId }));
    if (!hasSufficientFunds(fromProjection.state, command.amount)) {
      return yield* Effect.fail(
        new InsufficientFunds({
          walletId: command.fromWalletId,
          currentBalance: fromProjection.state.balance,
          requestedAmount: command.amount
        })
      );
    }

    const fromBalance = fromProjection.state.balance - command.amount;
    const toBalance = toProjection.state.balance + command.amount;

    // Both wallets resolve their "active period" against the same `now`, so fromPeriod/toPeriod
    // always share the same (year, month) in practice - one shared plain year/month tag pair on
    // the event (not separate from/to-prefixed variants), matching what
    // WalletQueryPatterns.singleWalletActivePeriodItems' MoneyTransferred query items actually
    // filter on (plain YEAR/MONTH tags, alongside the role-specific from_wallet_id/to_wallet_id
    // tag).
    const event = WalletEvents.moneyTransferred(
      {
        transferId: command.transferId,
        fromWalletId: command.fromWalletId,
        toWalletId: command.toWalletId,
        amount: command.amount,
        fromBalance,
        toBalance,
        transferredAt: new Date().toISOString(),
        description: command.description
      },
      [
        Tag.of(WalletTags.YEAR, String(fromPeriod.year)),
        Tag.of(WalletTags.MONTH, String(fromPeriod.month)),
        Tag.of(WalletTags.FROM_STATEMENT_ID, fromPeriod.statementId),
        Tag.of(WalletTags.TO_STATEMENT_ID, toPeriod.statementId)
      ]
    );

    return CD.nonCommutative(event, decisionModel, projection.streamPosition);
  });
