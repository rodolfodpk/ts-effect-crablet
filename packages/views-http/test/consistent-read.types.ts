// Compile-time tests (never executed): the read wrapper takes the database and the view progress hub where the group is built, and the handler it
// gives needs nothing more to settle the views. Before, a cast said the default `settle` needed whatever `R` the caller named.
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { ViewProgressHub } from "@crablet/views/ViewProgressHub";
import type { SettleViews } from "@crablet/views/SettleViews";
import { type ConsistentRead, type makeConsistentRead, makeConsistentReadWith } from "../src/ReadsLive.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Made = ReturnType<typeof makeConsistentRead>;

export const makingItNeedsTheDatabaseAndTheHub: Equal<Effect.Services<Made>, SqlClient.SqlClient | ViewProgressHub> = true;
export const theWrapperNeedsNothingMore: Equal<Effect.Success<Made>, ConsistentRead<never>> = true;

declare const settle: SettleViews<SqlClient.SqlClient>;
export const anotherSettleCarriesItsOwn: Equal<ReturnType<typeof makeConsistentReadWith<SqlClient.SqlClient>>, ConsistentRead<SqlClient.SqlClient>> = true;
export const takenFromTheSettle = (): ConsistentRead<SqlClient.SqlClient> => makeConsistentReadWith(settle);

declare const made: Made;
// @ts-expect-error making the wrapper with the database alone, and no hub, does not compile
export const withoutAHub: Effect.Effect<ConsistentRead<never>, never, SqlClient.SqlClient> = made;
// Where it shows: the handler a wrapper gives. Over the wrapper from `makeConsistentRead`, settling adds nothing to what the handler itself needs;
// over a settle that needs the database, the handler needs it.
declare const wrapper: ConsistentRead<never>;
const spec = { reads: [], parse: (_request: { readonly query: {} }) => Effect.succeed(1) };
const handled = wrapper(spec, () => Effect.succeed("ok"))({ query: {} });
const overTheDatabase = makeConsistentReadWith(settle)(spec, () => Effect.succeed("ok"))({ query: {} });
export const settledForFree: Equal<Effect.Services<typeof handled>, never> = true;
export const settledOverTheDatabase: Equal<Effect.Services<typeof overTheDatabase>, SqlClient.SqlClient> = true;
// @ts-expect-error a handler whose settle needs the database is not one that needs nothing
export const notForFree: Effect.Effect<unknown, unknown, never> = overTheDatabase;
