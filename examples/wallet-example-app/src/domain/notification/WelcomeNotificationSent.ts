import * as Schema from "effect/Schema";
import { defineEvent, Instant, personal } from "@crablet/commands/Domain";
import * as WalletTags from "../WalletTags.ts";

export const WelcomeNotificationSent = defineEvent("WelcomeNotificationSent", {
  schema: Schema.Struct({ walletId: Schema.String, owner: personal(Schema.String), sentAt: Instant }),
  tags: (d) => ({ [WalletTags.WALLET_ID]: d.walletId })
});

export const WELCOME_NOTIFICATION_SENT = WelcomeNotificationSent.type;
