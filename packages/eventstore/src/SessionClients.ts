import { Context, Effect, Layer, Ref } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { PgClient } from "@effect/sql-pg";

// The connections that live as long as a process holds a role: the modules' LEADERS (session-level advisory locks on one reserved connection) and the LISTENs (one connection of their own).
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
  // The session pool's size, and how many of its connections what has started so far keeps for good (counted by `holdSession`).
  readonly maxConnections: number | undefined;
  readonly held: Ref.Ref<number>;
  readonly warned: Ref.Ref<boolean>;
  // Whether the process's one lock session (ADR-0046) has been counted.
  readonly lockSessionCounted: Ref.Ref<boolean>;
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

// What a process keeps in the session pool for good: ONE reserved connection for the locks of every module that leads there (ADR-0046), counted once, when the first module tries for its
// lock (`holdSessionOnce`). Its LISTENs are not in the pool: they share one connection of their own, opened with the client's settings (`sharedListen`, ADR-0046's second half), so a
// process with views + automations + outbox + api keeps 1 pooled connection and 1 LISTEN connection (it was 5 pooled, and 7 with a connection per lock); api alone, the LISTEN connection
// only. A pool smaller than what is kept does not fail: what does not fit waits, and a module can be left without a leader (a leader gives up after `reserveTimeout` and says so).
export const sessionPoolWarning = (maxConnections: number | undefined, holds: number | undefined): string | null =>
  maxConnections === undefined || holds === undefined || maxConnections >= holds
    ? null
    : `session connections: maxConnections is ${maxConnections}, but this process keeps ${holds} of them for good (the leader locks' session); the rest wait. Use ${holds} or more (the library's default is 10).`;

// Count `n` more session connections kept for good by something that has just started (`what`), and warn once if the session pool is smaller than the total.
// Without session clients there is nothing to count: the leader and the LISTEN share the application's pool, which `Crablet.layer`'s caller sizes.
export const holdSession = (what: string, n: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    const session = yield* Effect.service(SessionClients);
    if (session === null) return;
    const total = yield* Ref.updateAndGet(session.held, (h) => h + n);
    const warning = sessionPoolWarning(session.maxConnections, total);
    if (warning !== null && !(yield* Ref.getAndSet(session.warned, true))) yield* Effect.logWarning(`${warning} (last to start: ${what})`);
  });

// `holdSession`, once: for a module whose first attempt at its lock marks that it has started (later attempts are retries, not new connections). The
// process's lock session is counted once, by the first module that starts; a module's LISTEN is not in the pool (`sharedListen`).
export const holdSessionOnce = (what: string): Effect.Effect<Effect.Effect<void>> =>
  Effect.map(Ref.make(false), (done) =>
    Effect.flatMap(Ref.getAndSet(done, true), (was) =>
      was
        ? Effect.void
        : Effect.gen(function* () {
            const session = yield* Effect.service(SessionClients);
            const lockSession = session === null ? 0 : (yield* Ref.getAndSet(session.lockSessionCounted, true)) ? 0 : 1;
            yield* holdSession(what, lockSession);
          })
    )
  );

// A second client, for the session connections, over `config` (the same shape as the application's: host, port, database, username, password, maxConnections).
//
// Its pool must hold what the process keeps for good (see `sessionPoolWarning`), plus room for the attempts of the modules that do not lead (one each). The first version of this advice
// said 5 for every process, and a wallet behind PgBouncer never got its outbox leader back after its connection was killed.
// (A `Reference` is not tracked in a layer's output type, hence `Layer<never, ...>`.)
export const sessionClientsLayer = (config: PgClient.PgPoolConfig): Layer.Layer<never, SqlError> =>
  Layer.effect(
    SessionClients,
    Effect.gen(function* () {
      const context = yield* Layer.build(PgClient.layer(config));
      return {
        pg: Context.get(context, PgClient.PgClient),
        sql: Context.get(context, SqlClient.SqlClient),
        maxConnections: config.maxConnections,
        held: yield* Ref.make(0),
        warned: yield* Ref.make(false),
        lockSessionCounted: yield* Ref.make(false)
      };
    })
  );
