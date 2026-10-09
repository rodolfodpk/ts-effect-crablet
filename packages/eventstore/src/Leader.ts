import { Duration, Effect, Exit, Fiber, Scope } from "effect";
import { EVENTS_CHANNEL } from "./EventStore.ts";
import type { SqlClient } from "effect/sql";
import type { Connection } from "effect/sql/SqlConnection";
import { ConnectionError, SqlError } from "effect/sql/SqlError";

// Session-level pg_try_advisory_lock/pg_advisory_unlock on a
// dedicated connection that is held open indefinitely on success (never returned to the pool
// until explicitly released), and closed immediately on failure.
//
// A session-level advisory lock lives exactly as long as the session that took it: if that connection dies (a network failure, a restart, an
// administrator's `pg_terminate_backend`), Postgres drops the lock at once and another instance can take it. The leader must therefore KNOW when
// its connection is gone, or two instances lead at the same time (measured: docs/plans/reliability-and-scale-diagnostic.md, D1). Two things do that:
//
//   - a HEARTBEAT: a trivial query on the leader's own connection every `heartbeat` (default 1 s). A query that succeeds on this connection proves the
//     session is alive and so the lock is held at that instant (a reserved connection whose session dies fails every later query and never reconnects
//     silently: D4). `failuresBeforeLost` consecutive failures (default 2) make the leader LOST: `isLeader()` turns false and the connection is released.
//   - `verify`: the same check on demand, used by the processor right before it does work that must not be done by a non-leader (it fails closed: a
//     failed check answers false at once, even before the heartbeat would call the leader lost).
//
// Uses SqlClient's public `reserve: Effect<Connection, SqlError, Scope>` primitive (verified in
// effect/sql/SqlConnection) rather than a raw pg.Client, since
// `reserve` already gives a pooled-but-pinned connection tied to an Effect Scope we control -
// the "hold it open, don't return it to the pool" shape leadership needs.

export const OUTBOX_LOCK_KEY = 4856221667890123456n;
export const VIEWS_LOCK_KEY = 4856221667890123457n;
export const AUTOMATIONS_LOCK_KEY = 4856221667890123458n;

export interface LeaderOptions {
  // How often the leader checks its own connection (default 1 second).
  readonly heartbeat?: Duration.Input;
  // How long a check may take before it counts as failed (default 2 seconds): a connection that answers nothing is as lost as one that errors.
  readonly verifyTimeout?: Duration.Input;
  // How long to wait for the client's pool to give the connection the lock is taken on (default 10 seconds). A pool whose connections are all held (by other leaders, by LISTENs: with
  // @effect/sql-pg each takes one for as long as it lasts) gives none, and a wait with no limit made the module never lead, silently. On the limit the attempt fails saying so.
  readonly reserveTimeout?: Duration.Input;
  // Consecutive failed checks before the leader is lost (default 2): one slow answer does not end leadership.
  readonly failuresBeforeLost?: number;
}

export interface LeaderHandle {
  readonly lockKey: bigint;
  // True until the leader is released on purpose or lost (its session died or stopped answering).
  isLeader(): boolean;
  // Is the lock still held right now? Runs a check on the leader's own connection: true if it answers, false if it fails or times out (and false once the
  // handle is released or lost). Two consecutive failures make the handle lost.
  readonly verify: Effect.Effect<boolean>;
  release(): Effect.Effect<void>;
}

// What a leader knows about itself, as a value, with pure transitions (the same "functional core, imperative shell" as the poller's BackoffState). `leading` until the
// lock is released on purpose (`closed`) or the session is judged gone (`lost`); `failures` counts consecutive failed checks. A lost leader is released next, so
// `lost` is passed through on the way to `closed`.
export interface LeaderState {
  readonly status: "leading" | "lost" | "closed";
  readonly failures: number;
}

export const leading: LeaderState = { status: "leading", failures: 0 };

// The state after one check of the lock. A good check resets the count; `failuresBeforeLost` bad ones in a row make the leader lost; a leader that is no longer leading
// stays as it is.
export const afterCheck = (state: LeaderState, alive: boolean, failuresBeforeLost: number): LeaderState => {
  if (state.status !== "leading") return state;
  if (alive) return state.failures === 0 ? state : { status: "leading", failures: 0 };
  const failures = state.failures + 1;
  return failures >= failuresBeforeLost ? { status: "lost", failures } : { status: "leading", failures };
};

export const afterRelease = (state: LeaderState): LeaderState => ({ status: "closed", failures: state.failures });

// PATTERN PRIMER - `Scope`, Effect's resource-lifecycle primitive (scoped cleanup,
// capability-based rather than syntax-based). A `Scope` is a
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
// creates one that isn't tied to anything yet, `Scope.provide(sql.reserve, scope)` borrows a pooled
// connection but registers its "return to pool" finalizer against *our* scope instead of an
// implicit one, and the resulting `LeaderHandle.release()` (below) calls `Scope.close(...)`
// explicitly, on our own schedule, whenever the caller decides leadership should end - not when
// some lexical block exits.
export const tryAcquireGlobalLeader = (
  sql: SqlClient.SqlClient,
  lockKey: bigint,
  options: LeaderOptions = {}
): Effect.Effect<LeaderHandle | null, SqlError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const reserveTimeout = Duration.fromInputUnsafe(options.reserveTimeout ?? "10 seconds");
    return yield* attempt(sql, lockKey, options, scope, reserveTimeout).pipe(
      // Whatever the attempt ends as, other than a leader that keeps the scope (and so its connection), the connection goes back to the pool: before this a failure of the first
      // statement, or an interruption while waiting, left the pool one connection short for good.
      Effect.onExit((exit) => (Exit.isSuccess(exit) && exit.value !== null ? Effect.void : Scope.close(scope, Exit.void)))
    );
  });

const attempt = (
  sql: SqlClient.SqlClient,
  lockKey: bigint,
  options: LeaderOptions,
  scope: Scope.Closeable,
  reserveTimeout: Duration.Duration
): Effect.Effect<LeaderHandle | null, SqlError> =>
  Effect.gen(function* () {
    const connection: Connection = yield* Scope.provide(sql.reserve, scope).pipe(
      Effect.timeout(reserveTimeout),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new SqlError({
            reason: new ConnectionError({
              cause: new Error("reserve timed out"),
              message: `no connection from the pool in ${Duration.toMillis(reserveTimeout)} ms for the leader lock ${lockKey}: the pool's connections are all held (leader locks and LISTENs hold one each for as long as they last; a process that runs the three modules holds 7). Raise maxConnections.`
            })
          })
        )
      )
    );

    const rows = yield* connection.execute(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [lockKey.toString()],
      undefined
    );
    const acquired = Boolean((rows[0] as { acquired: boolean } | undefined)?.acquired);

    if (!acquired) return null;

    const heartbeat = Duration.fromInputUnsafe(options.heartbeat ?? "1 second");
    const verifyTimeout = Duration.fromInputUnsafe(options.verifyTimeout ?? "2 seconds");
    const failuresBeforeLost = Math.max(1, options.failuresBeforeLost ?? 2);

    // `isLeader()` is synchronous (the poller asks it on every tick), so the state is one plain cell here, read and replaced only through the pure transitions above,
    // never mutated in pieces; a `Ref` would make that read an Effect.
    let state: LeaderState = leading;
    let monitor: Fiber.Fiber<void> | null = null;

    const release = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (state.status === "closed") return;
        state = afterRelease(state);
        // Unlock and announce in ONE statement: the notification is delivered on commit, after the unlock took effect, so a follower that wakes
        // on it finds the lock free. It is a wildcard on `crablet_events`, the channel every poller already listens to, so followers try for
        // the lock now instead of when their retry timer fires. A session that died cannot announce: its followers wait for their timer.
        // On a dead connection the unlock fails (or, on a half-open one, would hang): bound it, and ignore it. The lock is gone with the session.
        yield* connection.execute("SELECT pg_advisory_unlock($1), pg_notify($2, '*')", [lockKey.toString(), EVENTS_CHANNEL], undefined).pipe(
          Effect.timeout(verifyTimeout),
          Effect.catch(() => Effect.void)
        );
        yield* Scope.close(scope, Exit.void);
        if (monitor !== null) yield* Fiber.interrupt(monitor);
      });

    // Not `SELECT 1`: after the session is killed the pooled connection can come back on a NEW session that answers queries but
    // does not hold the lock (measured: the heartbeat failed once, then succeeded). Leadership is true only while THIS session
    // still holds the advisory lock, so ask Postgres exactly that.
    const alive: Effect.Effect<boolean> = connection
      .execute(
        `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()
         AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
        [lockKey.toString()],
        undefined
      )
      .pipe(
        Effect.timeout(verifyTimeout),
        Effect.map((rows) => rows.length > 0),
        Effect.catch(() => Effect.succeed(false))
      );

    const verify: Effect.Effect<boolean> = Effect.gen(function* () {
      if (state.status !== "leading") return false;
      const isAlive = yield* alive;
      state = afterCheck(state, isAlive, failuresBeforeLost);
      if (state.status === "lost") {
        // release from ANOTHER fiber: the caller may be the monitor itself, which release() interrupts
        yield* Effect.forkDetach(release());
      }
      return isAlive;
    });

    const handle: LeaderHandle = {
      lockKey,
      isLeader: () => state.status === "leading",
      verify,
      release
    };

    monitor = yield* Effect.forkDetach(
      Effect.gen(function* () {
        while (state.status === "leading") {
          yield* Effect.sleep(heartbeat);
          if (state.status !== "leading") break;
          yield* verify;
        }
      })
    );

    return handle;
  });
