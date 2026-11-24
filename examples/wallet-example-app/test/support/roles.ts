import { ConfigProvider, Effect } from "effect";
import type * as Crablet from "@crablet/app";
import { walletConfig } from "../../src/config.ts";

// The roles a WALLET_ROLES value gives, read the way the wallet reads it.
export const rolesFromValue = (value: string): Crablet.Roles<"api"> =>
  Effect.runSync(Effect.gen(function* () { return (yield* walletConfig).roles; }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { WALLET_ROLES: value } })))));
