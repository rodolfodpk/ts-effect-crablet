// Compile-time tests (never executed): waiting for a write needs the view progress hub, and says so. Before, the wait looked the hub up with
// `serviceOption`: forgetting it compiled, and every wait polled the table every 25 ms.
import type { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { ViewFailed, WaitTimeout, waitUntilProcessed } from "../src/WaitUntilProcessed.ts";
import type { settleViews } from "../src/SettleViews.ts";
import type { ViewProgressHub, ViewProgressHubLive, viewProgressPolling } from "../src/ViewProgressHub.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Wait = ReturnType<typeof waitUntilProcessed>;
type Settle = ReturnType<typeof settleViews>;

export const theWaitNeedsTheHub: Equal<Effect.Services<Wait>, SqlClient.SqlClient | ViewProgressHub> = true;
export const settlingNeedsTheHub: Equal<Effect.Services<Settle>, SqlClient.SqlClient | ViewProgressHub> = true;
export const theWaitFailsWith: Equal<Effect.Error<Wait>, WaitTimeout | ViewFailed | SqlError> = true;
// Both hubs give the one service: either satisfies the wait.
export const liveGivesTheHub: Equal<Layer.Success<typeof ViewProgressHubLive>, ViewProgressHub> = true;
export const pollingGivesTheHub: Equal<Layer.Success<ReturnType<typeof viewProgressPolling>>, ViewProgressHub> = true;
export const pollingNeedsOnlyTheDatabase: Equal<Layer.Services<ReturnType<typeof viewProgressPolling>>, SqlClient.SqlClient> = true;

declare const wait: Wait;
// @ts-expect-error a wait run with the database alone, and no hub, does not compile
export const withoutAHub: Effect.Effect<void, WaitTimeout | ViewFailed | SqlError, SqlClient.SqlClient> = wait;
