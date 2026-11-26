// The welcome-notification slice: an opened wallet gets one welcome, through an automation and the command it runs (not served over HTTP).
import { walletOpenedAutomation } from "./WalletOpenedAutomation.ts";

export * from "./WelcomeNotificationSent.ts";
export * from "./SendWelcomeNotificationCommand.ts";
export * from "./WalletOpenedAutomation.ts";

// What the automations module runs for this slice (processes.ts).
export const welcomeNotificationAutomations = [walletOpenedAutomation];
