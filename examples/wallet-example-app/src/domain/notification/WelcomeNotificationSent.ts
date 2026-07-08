import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import * as WalletTags from "../WalletTags.ts";

// Port of com.crablet.examples.wallet.notification.events.WelcomeNotificationSent.
export const WELCOME_NOTIFICATION_SENT = "WelcomeNotificationSent";

export interface WelcomeNotificationSent {
  readonly walletId: string;
  readonly owner: string;
  readonly sentAt: string;
}

export const welcomeNotificationSent = (data: WelcomeNotificationSent): AppendEvent.AppendEvent =>
  AppendEvent.of(WELCOME_NOTIFICATION_SENT, WalletTags.WALLET_ID, data.walletId, data);
