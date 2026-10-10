import * as Schema from "effect/Schema";
import { defineCommand, emit } from "@crablet/commands/Command";
import { OpenWalletContract } from "../WalletContracts.ts";
import { WalletOpened } from "../WalletModel.ts";
import * as WalletTags from "../WalletTags.ts";

export type OpenWalletCommand = Schema.Schema.Type<(typeof OpenWalletContract)["input"]>;

// Needs no state. Idempotent on the wallet id with onDuplicate "fail": a second "open" for the same
// wallet is a genuine conflict (surfaced as `Duplicate`), not a silent no-op - unlike every other wallet
// command, which is safe to retry.
export const OpenWallet = defineCommand({
  ...OpenWalletContract,
  idempotentBy: (c) => WalletOpened.where({ [WalletTags.WALLET_ID]: c.walletId }),
  onDuplicate: "fail",
  decide: (_, c, _prepared, { now }) => emit(WalletOpened({ ...c, openedAt: now.toISOString() }))
});
