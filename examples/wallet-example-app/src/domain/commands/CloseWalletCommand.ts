import { Effect } from "effect";
import { EventStore } from "@crablet/eventstore";
import * as StreamPositionNS from "@crablet/eventstore/StreamPosition";
import type { SqlError } from "@effect/sql/SqlError";
import type { CommandHandler } from "@crablet/commands";
import * as CD from "@crablet/commands/CommandDecision";
import * as WalletQueryPatterns from "../WalletQueryPatterns.ts";
import { walletBalanceProjector } from "../WalletBalanceProjector.ts";
import * as WalletEvents from "../events/WalletEvents.ts";
import { WalletNotFound } from "../errors/WalletErrors.ts";

export interface CloseWalletCommand {
  readonly walletId: string;
}

// Port of com.crablet.examples.wallet.commands.CloseWalletCommandHandler. NonCommutative over the
// lifecycle-only decision model - protects against racing closes the same way Withdraw/Transfer
// protect against racing balance changes. No `AppendCondition.failIfChanged` needed as a separate
// CommandDecision variant (an earlier draft of this port incorrectly assumed one exists) -
// CommandExecutor.ts's own dispatch already builds that exact "fail if changed since this
// position" check for every plain NonCommutative decision.
export const closeWalletCommandHandler: CommandHandler<CloseWalletCommand, WalletNotFound | SqlError> = (command) =>
  Effect.gen(function* () {
    const eventStore = yield* EventStore;
    const lifecycleModel = WalletQueryPatterns.walletLifecycleModel(command.walletId);
    const projection = yield* eventStore.project(lifecycleModel, StreamPositionNS.zero(), [walletBalanceProjector]);

    if (!projection.state.exists) return yield* Effect.fail(new WalletNotFound({ walletId: command.walletId }));

    const event = WalletEvents.walletClosed({ walletId: command.walletId, closedAt: new Date().toISOString() });
    return CD.nonCommutative(event, lifecycleModel, projection.streamPosition);
  });
