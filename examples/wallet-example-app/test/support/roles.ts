import { ConfigProvider, Effect } from "effect";
import { walletConfig } from "../../src/config.ts";
import { rolesOf, type Roles } from "../../src/roles.ts";

// The roles a WALLET_ROLES value gives, read the way the wallet reads it.
export const rolesFromValue = (value: string): Roles =>
  rolesOf(Effect.runSync(Effect.gen(function* () { return (yield* walletConfig).roles; }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { WALLET_ROLES: value } }))))));
