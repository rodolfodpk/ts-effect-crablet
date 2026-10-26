import { Effect, Exit, type Queue, Scope, Semaphore } from "effect";
import { PgConnection, type PgClient } from "@effect/sql-pg";
import type { SqlError } from "effect/sql/SqlError";

// ONE LISTEN CONNECTION PER PROCESS. With @effect/sql-pg, `pg.listen(channel)` reserves a pooled connection for each call, so a process whose views,
// automations and outbox wake on `crablet_events`, beside the views' progress hub, kept four connections for LISTEN, and the server sent every
// notification of `crablet_events` three times. A Postgres session can listen on any number of channels, and @effect/sql-pg fans one channel out to
// every listener of it on one connection; what it does not offer is one connection for all of a client's listens. This is that: every LISTEN of a
// process on one `PgClient` runs on one connection, opened for the first and closed with the last.
//
// The connection is its own, outside the client's pool (`PgConnection.make` with the client's config), and pinned once, so every listen on it shares
// it. When it is lost, every queue on it fails, as each LISTEN's did when it had its own: each wake-up stream reconnects (`wakeupStreamFrom`) and
// announces a wildcard; the first to listen again finds the connection gone, replaces it, and the others listen on the new one.

// What a listen runs on: a connection, or a stand-in in a test.
export interface Listener {
  readonly listen: (channel: string) => Effect.Effect<Queue.Dequeue<{ readonly payload: string }, SqlError>, SqlError, Scope.Scope>;
}

export interface SharedListener {
  // LISTEN on `channel`, on the shared connection, for as long as the caller's scope lasts.
  readonly listen: (channel: string) => Effect.Effect<Queue.Dequeue<{ readonly payload: string }, SqlError>, SqlError, Scope.Scope>;
}

// The shared connection over `connect`, which opens one in the scope it is given.
export const makeSharedListener = (connect: Effect.Effect<Listener, SqlError, Scope.Scope>): SharedListener => {
  // The connection and how many listens it serves change only under the permit.
  const permit = Semaphore.makeUnsafe(1);
  let current: { readonly scope: Scope.Closeable; readonly listener: Listener } | null = null;
  let users = 0;

  const drop = (connection: NonNullable<typeof current>): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (current === connection) current = null;
      return Scope.close(connection.scope, Exit.void);
    });

  const open = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const listener = yield* Scope.provide(connect, scope).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
    current = { scope, listener };
    return current;
  });

  const leave = Semaphore.withPermit(
    permit,
    Effect.suspend(() => {
      users -= 1;
      return users === 0 && current !== null ? drop(current) : Effect.void;
    })
  );

  const listen = (channel: string) =>
    Effect.gen(function* () {
      const caller = yield* Scope.Scope;
      return yield* Semaphore.withPermit(
        permit,
        Effect.gen(function* () {
          // Counted before anything can fail, and given back when the caller's scope closes, after its UNLISTEN (finalizers run in reverse).
          yield* Effect.uninterruptible(Effect.andThen(Effect.sync(() => void (users += 1)), Scope.addFinalizer(caller, leave)));
          const first = current ?? (yield* open);
          const exit = yield* Effect.exit(Scope.provide(first.listener.listen(channel), caller));
          if (Exit.isSuccess(exit)) return exit.value;
          // A listen on a lost connection fails: replace it, once. (Every queue on it has failed too, and their streams are reconnecting.)
          yield* drop(first);
          const second = yield* open;
          return yield* Scope.provide(second.listener.listen(channel), caller);
        })
      );
    });

  return { listen };
};

// The shared LISTEN connection of `pg`: one per client, opened with the client's own settings.
const byClient = new WeakMap<PgClient.PgClient, SharedListener>();
export const sharedListen = (pg: PgClient.PgClient, channel: string): Effect.Effect<Queue.Dequeue<{ readonly payload: string }, SqlError>, SqlError, Scope.Scope> => {
  let shared = byClient.get(pg);
  if (shared === undefined) {
    shared = makeSharedListener(Effect.flatMap(PgConnection.make(pg.config), (connection) => connection.pin));
    byClient.set(pg, shared);
  }
  return shared.listen(channel);
};
