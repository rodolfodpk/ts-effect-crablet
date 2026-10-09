import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { PgClient } from "@effect/sql-pg";

// The connections that live as long as a process holds a role: a module's LEADER (a session-level advisory lock on a reserved connection) and every LISTEN.
//
// Behind a connection pooler in transaction mode (PgBouncer, or RDS Proxy, which pins instead) neither survives: the pooler hands the server connection to another client
// between transactions, so the lock is lost (or another instance gets it too) and a LISTEN hears nothing, without an error. Measured behind PgBouncer 1.26, transaction
// mode: a second instance took the lock 11 times in 40 tries while the first held it, and the first one's own check said it had lost it every time, and 0 of 20 notifications arrived. The commands, the appends and the views'
// transactions are not affected: they take only transaction-level locks. So only these two need a direct connection to the database.
//
// `SessionClients` names that direct connection. It is optional: when it is not provided, the leader and the LISTEN use the application's own `SqlClient` and
// `PgClient`, exactly as before. Provide it with `sessionClientsLayer(config)` (or `Crablet.layer(pg, { session })`) to point them at another endpoint.
//
// A `Context.Reference` with a default of `null`, like `PendingWakeups`, so no module gets a new required service.
export interface SessionClients {
  readonly sql: SqlClient.SqlClient;
  readonly pg: PgClient.PgClient;
}

export const SessionClients = Context.Reference<SessionClients | null>("crablet/SessionClients", { defaultValue: () => null });

// What a leader reserves its connection from: the session client when there is one, else the application's.
export const sessionSql: Effect.Effect<SqlClient.SqlClient, never, SqlClient.SqlClient> = Effect.gen(function* () {
  const session = yield* Effect.service(SessionClients);
  return session !== null ? session.sql : yield* SqlClient.SqlClient;
});

// What LISTEN runs on: the session client when there is one, else the application's.
export const sessionPg: Effect.Effect<PgClient.PgClient, never, PgClient.PgClient> = Effect.gen(function* () {
  const session = yield* Effect.service(SessionClients);
  return session !== null ? session.pg : yield* PgClient.PgClient;
});

// A second client, for the session connections, over `config` (the same shape as the application's: host, port, database, username, password, maxConnections).
//
// Its pool must hold what the process keeps for good: one connection per module that leads (a reserved one, at most three), and one per LISTEN, which with @effect/sql-pg takes a pooled
// connection for as long as it lasts (the three modules' wake-ups and the views' progress hub: four). Seven for a process that runs everything, the default of 10 leaves room for the
// attempts of the modules that do not lead. Too small a pool does not fail: the connections that do not fit wait, and a module can stay without a leader (the first version of this advice
// said 5, and a wallet behind PgBouncer never got its outbox leader back after its connection was killed). A leader now gives up waiting after `reserveTimeout` and says so.
const MIN_POOL = 7;

// (A `Reference` is not tracked in a layer's output type, hence `Layer<never, ...>`.)
export const sessionClientsLayer = (config: Parameters<typeof PgClient.layer>[0]): Layer.Layer<never, SqlError> =>
  Layer.effect(
    SessionClients,
    Effect.gen(function* () {
      if (config.maxConnections !== undefined && config.maxConnections < MIN_POOL) {
        yield* Effect.logWarning(
          `session connections: maxConnections is ${config.maxConnections}; a process that runs the three modules keeps ${MIN_POOL} for good (3 leader locks, 4 LISTEN) and the rest wait. Use ${MIN_POOL} or more (10 is the default).`
        )
      }
      const context = yield* Layer.build(PgClient.layer(config));
      return { pg: Context.get(context, PgClient.PgClient), sql: Context.get(context, SqlClient.SqlClient) };
    })
  );
