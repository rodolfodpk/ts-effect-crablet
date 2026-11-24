import { Effect } from "effect";
import * as Crablet from "@crablet/app";

// The wallet's settings, from WALLET_* (docs/reference/configuration.md): the connection (WALLET_DB_*, WALLET_DB_URL, WALLET_DB_POOL, WALLET_DB_SESSION_*),
// the polling (WALLET_POLL_MS, WALLET_BACKOFF_MAX_SECONDS), the wake-ups (WALLET_WAKEUPS), the roles (WALLET_ROLES; `api` is the wallet's own, the
// others are its modules) and WALLET_MIGRATE. The defaults match docker-compose.yml. A bad value stops the start with a ConfigError naming the variable.
export const walletConfig = Crablet.config("WALLET", { roles: ["api"], database: { name: "wallet_db", username: "postgres", password: "postgres" } });

export const readWalletConfig = (): Promise<Crablet.Settings<"api">> => Effect.runPromise(Effect.gen(function* () { return yield* walletConfig; }));
