import * as Schema from "effect/Schema";
import { defineCommand, emit } from "@crablet/commands/Command";
import { personal } from "@crablet/commands/Personal";
import { NonBlank, NonNegative } from "../WalletInputs.ts";
import { WalletOpened } from "../WalletModel.ts";
import * as WalletTags from "../WalletTags.ts";

const input = Schema.Struct({ walletId: NonBlank, owner: personal(NonBlank), initialBalance: NonNegative });
export type OpenWalletCommand = Schema.Schema.Type<typeof input>;

// Needs no state. Idempotent on the wallet id with onDuplicate "fail": a second "open" for the same
// wallet is a genuine conflict (surfaced as `Duplicate`), not a silent no-op - unlike every other wallet
// command, which is safe to retry.
export const OpenWallet = defineCommand({
  name: "open_wallet",
  input,
  idempotentBy: (c) => WalletOpened.where({ [WalletTags.WALLET_ID]: c.walletId }),
  onDuplicate: "fail",
  decide: (_, c) => emit(WalletOpened({ ...c, openedAt: new Date().toISOString() }))
});
