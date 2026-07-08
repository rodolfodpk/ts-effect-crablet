import { Effect } from "effect";
import type { CommandHandler } from "@crablet/commands";
import * as CD from "@crablet/commands/CommandDecision";
import * as WalletTags from "../WalletTags.ts";
import * as WalletEvents from "../events/WalletEvents.ts";
import { InvalidOperation } from "../errors/WalletErrors.ts";

export interface OpenWalletCommand {
  readonly walletId: string;
  readonly owner: string;
  readonly initialBalance: number;
}

// Port of com.crablet.examples.wallet.commands.OpenWalletCommandHandler. Idempotent on
// (WalletOpened, wallet_id), onDuplicate: THROW - a second "open" for the same wallet_id is a
// genuine conflict (WalletAlreadyExists, surfaced as a DCB conflict via ConcurrencyException), not
// a silent no-op - unlike every other wallet command, which is safe to retry.
export const openWalletCommandHandler: CommandHandler<OpenWalletCommand, InvalidOperation> = (command) =>
  Effect.gen(function* () {
    if (!command.walletId.trim()) return yield* Effect.fail(new InvalidOperation({ message: "walletId must not be blank" }));
    if (!command.owner.trim()) return yield* Effect.fail(new InvalidOperation({ message: "owner must not be blank" }));
    if (command.initialBalance < 0) {
      return yield* Effect.fail(new InvalidOperation({ message: "initialBalance must not be negative" }));
    }

    const event = WalletEvents.walletOpened({
      walletId: command.walletId,
      owner: command.owner,
      initialBalance: command.initialBalance,
      openedAt: new Date().toISOString()
    });

    return CD.idempotent(event, WalletEvents.WALLET_OPENED, WalletTags.WALLET_ID, command.walletId, "THROW");
  });
