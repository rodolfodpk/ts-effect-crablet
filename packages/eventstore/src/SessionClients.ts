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

// What a process keeps in the session pool for good: one reserved connection per module that leads (3 locks at most), and one per LISTEN, which with @effect/sql-pg takes a pooled
// connection for as long as it lasts (one for each module's wake-ups, and one for the views' progress hub where the api runs). It depends on the roles the process runs, so whoever
// builds the layer says how many (`holds`); the layer does not guess. Measured, idle: a process with views + automations + outbox + api keeps 7; the three workers without api, 6; views
// alone, 2; api alone, 1. A pool smaller than that does not fail: what does not fit waits, and a module can be left without a leader (a leader gives up after `reserveTimeout` and says so;
// a LISTEN that does not fit just waits, and its process falls back to polling).
export const sessionPoolWarning = (maxConnections: number | undefined, holds: number | undefined): string | null =>
  maxConnections === undefined || holds === undefined || maxConnections >= holds
    ? null
    : `session connections: maxConnections is ${maxConnections}, but this process keeps ${holds} of them for good (leader locks and LISTENs); the rest wait. Use ${holds} or more (the library's default is 10).`;

// A second client, for the session connections, over `config` (the same shape as the application's: host, port, database, username, password, maxConnections).
//
// Its pool must hold what the process keeps for good (see `sessionPoolWarning`), plus room for the attempts of the modules that do not lead (one each). The first version of this advice
// said 5 for every process, and a wallet behind PgBouncer never got its outbox leader back after its connection was killed.
// (A `Reference` is not tracked in a layer's output type, hence `Layer<never, ...>`.)
export const sessionClientsLayer = (config: Parameters<typeof PgClient.layer>[0], options: { readonly holds?: number } = {}): Layer.Layer<never, SqlError> =>
  Layer.effect(
    SessionClients,
    Effect.gen(function* () {
      const warning = sessionPoolWarning(config.maxConnections, options.holds);
      if (warning !== null) yield* Effect.logWarning(warning);
      const context = yield* Layer.build(PgClient.layer(config));
      return { pg: Context.get(context, PgClient.PgClient), sql: Context.get(context, SqlClient.SqlClient) };
    })
  );
