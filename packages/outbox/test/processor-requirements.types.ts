// Compile-time tests (never executed), decision V1: building the outbox processor needs only the SQL client (a handle that is not running is read and
// controlled through the database), and what running it needs is the handle's run requirement, which starting it requires.
import type { Effect, Scope } from "effect";
import type { SqlClient } from "effect/sql";
import type { PgClient } from "@effect/sql-pg";
import type { ProcessorHandle } from "@crablet/event-poller";
import type { OutboxPublishers } from "../src/OutboxPublisher.ts";
import type { makeOutboxProcessor, startOutboxProcessor, OutboxRunRequirements } from "../src/OutboxModule.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Made = ReturnType<typeof makeOutboxProcessor>;
type Started = ReturnType<typeof startOutboxProcessor>;

export const buildingNeedsOnlyTheSqlClient: Equal<Effect.Services<Made>, SqlClient.SqlClient> = true;
export const runningNeeds: Equal<OutboxRunRequirements, PgClient.PgClient | OutboxPublishers> = true;
export const theHandleCarriesIt: Equal<Effect.Success<Made>, ProcessorHandle<OutboxRunRequirements>> = true;
// starting provides the publishers it is given, so what is left is the SQL client, the LISTEN client and the scope
export const startingNeeds: Equal<Effect.Services<Started>, SqlClient.SqlClient | PgClient.PgClient | Scope.Scope> = true;
