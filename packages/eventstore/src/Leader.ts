import { Effect, Exit, Scope } from "effect";
import type { SqlClient } from "@effect/sql";
import type { Connection } from "@effect/sql/SqlConnection";
import type { SqlError } from "@effect/sql/SqlError";

// Port of LeaderElectorImpl.java: session-level pg_try_advisory_lock/pg_advisory_unlock on a
// dedicated connection that is held open indefinitely on success (never returned to the pool
// until explicitly released), and closed immediately on failure. No heartbeat query - liveness
// is just "is the reserved connection still open" (Postgres auto-releases the lock server-side
// if the connection drops).
//
// Uses SqlClient's public `reserve: Effect<Connection, SqlError, Scope>` primitive (verified in
// node_modules/@effect/sql/dist/dts/SqlConnection.d.ts) rather than a raw pg.Client, since
// `reserve` already gives a pooled-but-pinned connection tied to an Effect Scope we control -
// the same "hold it open, don't return it to the pool" shape Java's LeaderElectorImpl uses.

export const OUTBOX_LOCK_KEY = 4856221667890123456n;
export const VIEWS_LOCK_KEY = 4856221667890123457n;
export const AUTOMATIONS_LOCK_KEY = 4856221667890123458n;

export interface LeaderHandle {
  readonly lockKey: bigint;
  isLeader(): boolean;
  release(): Effect.Effect<void>;
}

// PATTERN PRIMER - `Scope`, Effect's resource-lifecycle primitive (the answer to Java's
// try-with-resources / `Closeable`, but capability-based rather than syntax-based). A `Scope` is a
// value that resources can register cleanup logic against (`Scope.addFinalizer`, used internally
// by `sql.reserve`); when the scope closes, every registered finalizer runs, in reverse order.
// Normally you never touch `Scope` directly - `Effect.scoped(effect)` (see event-poller's
// EventProcessor.ts for an example) opens a scope, runs `effect`, and closes the scope the moment
// `effect` finishes, whether by success, failure, or interruption - that's the 99% case, and reads
// almost exactly like a `try (var x = ...) { ... }` block.
//
// This function is the 1% case: a leader-election lock needs to stay *held* for as long as this
// process remains leader, which is not "for the duration of one call" - it has no natural
// enclosing block to attach `Effect.scoped` to. So the scope is managed by hand: `Scope.make()`
// creates one that isn't tied to anything yet, `Scope.extend(sql.reserve, scope)` borrows a pooled
// connection but registers its "return to pool" finalizer against *our* scope instead of an
// implicit one, and the resulting `LeaderHandle.release()` (below) calls `Scope.close(...)`
// explicitly, on our own schedule, whenever the caller decides leadership should end - not when
// some lexical block exits.
export const tryAcquireGlobalLeader = (
  sql: SqlClient.SqlClient,
  lockKey: bigint
): Effect.Effect<LeaderHandle | null, SqlError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const connection: Connection = yield* Scope.extend(sql.reserve, scope);

    const rows = yield* connection.execute(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [lockKey.toString()],
      undefined
    );
    const acquired = Boolean((rows[0] as { acquired: boolean } | undefined)?.acquired);

    if (!acquired) {
      yield* Scope.close(scope, Exit.void);
      return null;
    }

    let closed = false;
    // No isClosed() equivalent on the abstract Connection - track liveness via our own flag,
    // set true only when we (or a crash-simulation test) actually tear the scope down.
    const handle: LeaderHandle = {
      lockKey,
      isLeader: () => !closed,
      release: () =>
        Effect.gen(function* () {
          if (closed) return;
          yield* connection.execute("SELECT pg_advisory_unlock($1)", [lockKey.toString()], undefined).pipe(
            Effect.catchAll(() => Effect.void)
          );
          yield* Scope.close(scope, Exit.void);
          closed = true;
        })
    };

    return handle;
  });
