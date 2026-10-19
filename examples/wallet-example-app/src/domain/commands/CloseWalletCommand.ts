import * as Schema from "effect/Schema";
import { byModel, defineCommand, emit, fail, noop } from "@crablet/commands/Command";
import { WalletNotFound } from "../errors/WalletErrors.ts";
import { CloseWalletContract } from "../WalletContracts.ts";
import { WalletClosed, WalletLifecycleModel } from "../WalletModel.ts";

export type CloseWalletCommand = Schema.Schema.Type<(typeof CloseWalletContract)["input"]>;

// Strict over the lifecycle-only boundary: protects against racing closes the same way withdrawals and
// transfers are protected against racing balance changes.
// A wallet closes once: a repeated close is "already closed" (decide answers the repeat).
export const CloseWallet = defineCommand({
  ...CloseWalletContract,
  model: (c) => WalletLifecycleModel.of({ id: c.walletId }),
  idempotentBy: byModel(),
  decide: (wallet, c, { now }) =>
    wallet.exists
      ? emit(WalletClosed({ walletId: c.walletId, closedAt: now.toISOString() }))
      : wallet.closed
        ? noop("ALREADY_CLOSED")
        : fail(new WalletNotFound({ walletId: c.walletId }))
});
