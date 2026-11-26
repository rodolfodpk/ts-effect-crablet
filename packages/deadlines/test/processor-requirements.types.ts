// Compile-time tests (never executed), decision V1: building the deadlines processor needs only the SQL client (a handle that is not running is read and
// controlled through the database), and what running it needs is the handle's run requirement, which starting it requires.
import type { Effect, Scope } from "effect";
import type { SqlClient } from "effect/sql";
import type { CommandExecutor } from "@crablet/commands";
import type { EventStore } from "@crablet/eventstore";
import type { ProcessorHandle } from "@crablet/event-poller";
import type { makeDeadlinesProcessor, startDeadlinesProcessor, DeadlinesRunRequirements } from "../src/DeadlinesProcessor.ts";
import type { ProcessConnections } from "@crablet/eventstore/ProcessConnections";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Made = ReturnType<typeof makeDeadlinesProcessor>;
type Started = ReturnType<typeof startDeadlinesProcessor>;

export const buildingNeedsOnlyTheSqlClient: Equal<Effect.Services<Made>, SqlClient.SqlClient> = true;
export const runningNeeds: Equal<DeadlinesRunRequirements, CommandExecutor | EventStore | ProcessConnections> = true;
export const theHandleCarriesIt: Equal<Effect.Success<Made>, ProcessorHandle<DeadlinesRunRequirements>> = true;
export const startingNeedsBoth: Equal<Effect.Services<Started>, SqlClient.SqlClient | DeadlinesRunRequirements | Scope.Scope> = true;
