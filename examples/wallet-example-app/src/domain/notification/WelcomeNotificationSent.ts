import * as Schema from "effect/Schema";
import { defineEvent } from "@crablet/commands/Event";
import * as WalletTags from "../WalletTags.ts";

export const WelcomeNotificationSent = defineEvent("WelcomeNotificationSent", {
  schema: Schema.Struct({ walletId: Schema.String, owner: Schema.String, sentAt: Schema.String }),
  tags: (d) => ({ [WalletTags.WALLET_ID]: d.walletId })
});

export const WELCOME_NOTIFICATION_SENT = WelcomeNotificationSent.type;
