import * as Schema from "effect/Schema";
import { defineCommand, emit } from "@crablet/commands/Command";
import { personal } from "@crablet/commands/Personal";
import * as WalletTags from "../WalletTags.ts";
import { WelcomeNotificationSent } from "./WelcomeNotificationSent.ts";

const input = Schema.Struct({ walletId: Schema.String, owner: personal(Schema.String) });
export type SendWelcomeNotificationCommand = Schema.Schema.Type<typeof input>;

// Issued by the wallet-opened automation, not exposed over HTTP. Needs no state, and is idempotent per
// wallet: the automation may see the same WalletOpened event more than once (at-least-once
// delivery), and the welcome is sent once.
// #region automation-command
export const SendWelcomeNotification = defineCommand({
  name: "SendWelcomeNotificationCommand",
  input,
  idempotentBy: (c) => WelcomeNotificationSent.where({ [WalletTags.WALLET_ID]: c.walletId }),
  decide: (_, c) => emit(WelcomeNotificationSent({ walletId: c.walletId, owner: c.owner, sentAt: new Date().toISOString() }))
});
// #endregion automation-command
