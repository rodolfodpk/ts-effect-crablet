// Compile-time tests (never executed), decision V1: building the views processor needs only the SQL client (a handle that is not running is read and
// controlled through the database), and what running it needs is the handle's run requirement, which starting it requires.
import type { Effect, Scope } from "effect";
import type { SqlClient } from "effect/sql";
import type { PgClient } from "@effect/sql-pg";
import type { ProcessorHandle } from "@crablet/event-poller";
import type { makeViewsProcessor, startViewsProcessor, ViewsRunRequirements } from "../src/ViewsProcessor.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Made = ReturnType<typeof makeViewsProcessor>;
type Started = ReturnType<typeof startViewsProcessor>;

export const buildingNeedsOnlyTheSqlClient: Equal<Effect.Services<Made>, SqlClient.SqlClient> = true;
export const runningNeeds: Equal<ViewsRunRequirements, PgClient.PgClient> = true;
export const theHandleCarriesIt: Equal<Effect.Success<Made>, ProcessorHandle<ViewsRunRequirements>> = true;
export const startingNeedsBoth: Equal<Effect.Services<Started>, SqlClient.SqlClient | ViewsRunRequirements | Scope.Scope> = true;
