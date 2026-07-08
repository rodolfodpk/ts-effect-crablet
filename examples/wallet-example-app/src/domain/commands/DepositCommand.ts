import { Effect } from "effect";
import { EventStore } from "@crablet/eventstore";
import * as StreamPositionNS from "@crablet/eventstore/StreamPosition";
import type { SqlError } from "@effect/sql/SqlError";
import type { ConcurrencyException } from "@crablet/eventstore/DCBViolation";
import type { CommandHandler } from "@crablet/commands";
import * as CD from "@crablet/commands/CommandDecision";
import * as WalletTags from "../WalletTags.ts";
import * as WalletEvents from "../events/WalletEvents.ts";
import * as WalletQueryPatterns from "../WalletQueryPatterns.ts";
import { walletBalanceProjector } from "../WalletBalanceProjector.ts";
import { resolveActivePeriod } from "../period/WalletStatementPeriodResolver.ts";
import { WalletNotFound, InvalidOperation } from "../errors/WalletErrors.ts";
import * as Tag from "@crablet/eventstore/Tag";

export interface DepositCommand {
  readonly depositId: string;
  readonly walletId: string;
  readonly amount: number;
  readonly description: string;
}

// Port of com.crablet.examples.wallet.commands.DepositCommandHandler. CommutativeGuarded (not
// NonCommutative): deposits commute with each other - two concurrent deposits don't conflict, so
// no full stream-position DCB check is needed - but a *lifecycle*-only guard query still catches a
// concurrent wallet close, and `.idempotent(DepositMade, deposit_id)` makes retries safe.
export const depositCommandHandler: CommandHandler<
  DepositCommand,
  WalletNotFound | InvalidOperation | SqlError | ConcurrencyException
> = (command) =>
  Effect.gen(function* () {
    if (command.amount <= 0) return yield* Effect.fail(new InvalidOperation({ message: "amount must be positive" }));

    const eventStore = yield* EventStore;
    const period = yield* resolveActivePeriod(eventStore, command.walletId);
    const projection = yield* eventStore.project(
      WalletQueryPatterns.singleWalletActivePeriodDecisionModel(command.walletId, period.year, period.month),
      StreamPositionNS.zero(),
      [walletBalanceProjector]
    );

    if (!projection.state.exists) return yield* Effect.fail(new WalletNotFound({ walletId: command.walletId }));

    const newBalance = projection.state.balance + command.amount;
    const event = WalletEvents.depositMade(
      {
        depositId: command.depositId,
        walletId: command.walletId,
        amount: command.amount,
        newBalance,
        depositedAt: new Date().toISOString(),
        description: command.description
      },
      [
        Tag.of(WalletTags.YEAR, String(period.year)),
        Tag.of(WalletTags.MONTH, String(period.month)),
        Tag.of(WalletTags.STATEMENT_ID, period.statementId)
      ]
    );

    const lifecycleGuard = WalletQueryPatterns.walletLifecycleModel(command.walletId);
    const decision = CD.withLifecycleGuard(event, lifecycleGuard, projection.streamPosition);
    return CD.commutativeGuardedIdempotent(decision, WalletEvents.DEPOSIT_MADE, WalletTags.DEPOSIT_ID, command.depositId);
  });
