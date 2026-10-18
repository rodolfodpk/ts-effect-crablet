import * as Schema from "effect/Schema";
import { defineCommand, emit, fail, noop } from "@crablet/commands/Command";
import { OpenWalletContract } from "../WalletContracts.ts";
import { WalletOpened, WalletOpeningModel } from "../WalletModel.ts";
import { WalletAlreadyExists } from "../errors/WalletErrors.ts";

export type OpenWalletCommand = Schema.Schema.Type<(typeof OpenWalletContract)["input"]>;

// The wallet id is chosen by the caller, so a second open of the same id is either a retry of the same request (the same owner and
// initial balance: "already opened", nothing appended) or a different wallet under an id that is taken (`WalletAlreadyExists`).
// Two opens racing on one id cannot both append: each decides on the id's opening, so the loser re-runs and sees the winner's.
export const OpenWallet = defineCommand({
  ...OpenWalletContract,
  model: (c) => WalletOpeningModel.of({ id: c.walletId }),
  idempotentBy: "decide", // the model shows whether it was done; decide answers a repeat
  decide: ({ opened }, c, { now }) =>
    opened === null
      ? emit(WalletOpened({ ...c, openedAt: now.toISOString() }))
      : opened.owner === c.owner && opened.initialBalance === c.initialBalance
        ? noop("ALREADY_OPENED")
        : fail(new WalletAlreadyExists({ walletId: c.walletId }))
});
