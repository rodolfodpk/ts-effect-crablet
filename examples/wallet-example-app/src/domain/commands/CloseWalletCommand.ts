import * as Schema from "effect/Schema";
import { defineCommand, emit, fail } from "@crablet/commands/Command";
import { WalletNotFound } from "../errors/WalletErrors.ts";
import { WalletClosed, WalletLifecycleModel } from "../WalletModel.ts";

const input = Schema.Struct({ walletId: Schema.String });
export type CloseWalletCommand = Schema.Schema.Type<typeof input>;

// Strict over the lifecycle-only boundary: protects against racing closes the same way withdrawals and
// transfers are protected against racing balance changes.
export const CloseWallet = defineCommand({
  name: "close_wallet",
  input,
  model: (c) => WalletLifecycleModel.of({ id: c.walletId }),
  decide: (wallet, c) =>
    wallet.exists
      ? emit(WalletClosed({ walletId: c.walletId, closedAt: new Date().toISOString() }))
      : fail(new WalletNotFound({ walletId: c.walletId }))
});
