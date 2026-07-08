import { Effect } from "effect";
import { EventStore } from "@crablet/eventstore";
import * as StreamPositionNS from "@crablet/eventstore/StreamPosition";
import * as Query from "@crablet/eventstore/Query";
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

export interface WithdrawCommand {
  readonly withdrawalId: string;
  readonly walletId: string;
  readonly amount: number;
  readonly description: string;
}

// Port of com.crablet.examples.wallet.commands.WithdrawCommandHandler - including its `handle()`
// override, not just `decide()`. Withdrawals are order-sensitive (a real balance check), so a full
// NonCommutative stream-position DCB check is required - but on retry, the balance has already
// been reduced by the first successful attempt, so re-running the balance check would wrongly
// throw InsufficientFunds. The duplicate pre-check below (does a WithdrawalMade for this
// withdrawal_id already exist?) must run *before* any balance logic, short-circuiting to NoOp -
// exactly mirroring Java's handler overriding `handle()` to pre-empt `decide()` entirely, rather
// than just adding idempotency at the decision level the way Deposit does.
export const withdrawCommandHandler: CommandHandler<
  WithdrawCommand,
  WalletNotFound | InsufficientFunds | InvalidOperation | SqlError | ConcurrencyException
> = (command) =>
  Effect.gen(function* () {
    if (command.amount <= 0) return yield* Effect.fail(new InvalidOperation({ message: "amount must be positive" }));

    const eventStore = yield* EventStore;

    const alreadyProcessed = yield* eventStore.exists(
      Query.forEventAndTag(WalletEvents.WITHDRAWAL_MADE, WalletTags.WITHDRAWAL_ID, command.withdrawalId)
    );
    if (alreadyProcessed) return CD.noOp("Duplicate withdrawal");

    const period = yield* resolveActivePeriod(eventStore, command.walletId);
    const projection = yield* eventStore.project(
      WalletQueryPatterns.singleWalletActivePeriodDecisionModel(command.walletId, period.year, period.month),
      StreamPositionNS.zero(),
      [walletBalanceProjector]
    );

    if (!projection.state.exists) return yield* Effect.fail(new WalletNotFound({ walletId: command.walletId }));
    if (!hasSufficientFunds(projection.state, command.amount)) {
      return yield* Effect.fail(
        new InsufficientFunds({
          walletId: command.walletId,
          currentBalance: projection.state.balance,
          requestedAmount: command.amount
        })
      );
    }

    const newBalance = projection.state.balance - command.amount;
    const event = WalletEvents.withdrawalMade(
      {
        withdrawalId: command.withdrawalId,
        walletId: command.walletId,
        amount: command.amount,
        newBalance,
        withdrawnAt: new Date().toISOString(),
        description: command.description
      },
      [
        Tag.of(WalletTags.YEAR, String(period.year)),
        Tag.of(WalletTags.MONTH, String(period.month)),
        Tag.of(WalletTags.STATEMENT_ID, period.statementId)
      ]
    );

    return CD.nonCommutative(
      event,
      WalletQueryPatterns.singleWalletActivePeriodDecisionModel(command.walletId, period.year, period.month),
      projection.streamPosition
    );
  });
