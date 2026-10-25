import { Duration, Effect, Exit, Fiber, Option, Scope } from "effect";
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
// its connection is gone, or two instances lead at the same time (measured: docs/history/plans/reliability-and-scale-diagnostic.md, D1). Two things do that:
//
//   - a HEARTBEAT: a check on the leader's own connection every `heartbeat` (default 1 s) that asks Postgres whether THIS session still holds the advisory
//     lock (`pg_locks`, `pid = pg_backend_pid()`). A query that merely answers proves nothing: after the session is killed the pooled connection can come
//     back on a NEW session that answers queries but holds no lock (D4, and its correction). `failuresBeforeLost` consecutive failures (default 2) make
//     the leader LOST: `isLeader()` turns false and the connection is released.
//   - `verify`: the same check on demand, used by the processor right before it does work that must not be done by a non-leader (it fails closed: a
//     failed check answers false at once, even before the heartbeat would call the leader lost).
//
// The other side has to find out too (ADR-0045). After a silent partition (no FIN, no RST) the leader knows within seconds, but Postgres keeps the
// session, and the lock, until its TCP keepalives give up: 388 s with the settings RDS ships. So the lock session sets `idle_session_timeout` for
// itself: the heartbeat's check renews it every second, and once the leader goes silent the server ends the session and the lock is free. The lease is
// the session. And a leader leads only on a primary: after a failover a cached DNS name can lead to the old writer, now a replica, where an advisory lock
// can still be taken but no write succeeds, so taking the lock and checking it both require `pg_is_in_recovery()` to be false.
//
// Uses SqlClient's public `reserve: Effect<Connection, SqlError, Scope>` primitive (verified in
// effect/sql/SqlConnection) rather than a raw pg.Client, since
// `reserve` already gives a pooled-but-pinned connection tied to an Effect Scope we control -
// the "hold it open, don't return it to the pool" shape leadership needs.

export const OUTBOX_LOCK_KEY = 4856221667890123456n;
export const VIEWS_LOCK_KEY = 4856221667890123457n;
export const AUTOMATIONS_LOCK_KEY = 4856221667890123458n;
// The deadlines processor (ADR-0043): a lock of its own, so it fails over independently of the automations although it runs in the same role.
export const DEADLINES_LOCK_KEY = 4856221667890123459n;

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
  // How long the server keeps a lock session its leader stopped talking on (`idle_session_timeout` on that session; default 15 seconds; "off" leaves it to
  // the TCP keepalives). It must be longer than the leader's own loss detection, `failuresBeforeLost x (heartbeat + verifyTimeout)`, so the old leader has
  // stopped before the lock is free; a shorter one is refused. The takeover after a silent partition is about this plus the followers' retry interval.
  readonly serverIdleTimeout?: Duration.Input | "off";
}

// When the leader has surely stopped after its connection went silent: `failuresBeforeLost` checks of `heartbeat` and `verifyTimeout` each.
export const lossDetectionBound = (options: Pick<LeaderOptions, "heartbeat" | "verifyTimeout" | "failuresBeforeLost">): Duration.Duration =>
  Duration.times(
    Duration.sum(Duration.fromInputUnsafe(options.heartbeat ?? "1 second"), Duration.fromInputUnsafe(options.verifyTimeout ?? "2 seconds")),
    Math.max(1, options.failuresBeforeLost ?? 2)
  );

// Waits for `effect` at most `limit`, without waiting for it to be interrupted. On a half-open connection (a silent partition) the driver's interruption
// of a statement sends a cancel request on a side connection and waits for the statement to drain, up to 5 seconds more (@effect/sql-pg 4.0.2): a
// plain `Effect.timeout` waits for that, and with it a leader whose loss detection is 1.4 s knew after 5.9 s (leader-partition.test.ts's settings). A late
// answer is no answer: the result is None at the limit, and the statement is interrupted in the background.
const within = <A, E>(limit: Duration.Duration, effect: Effect.Effect<A, E>): Effect.Effect<Option.Option<A>, E> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkDetach(effect);
    const result = yield* Effect.timeoutOption(Fiber.join(fiber), limit);
    if (Option.isNone(result)) yield* Effect.forkDetach(Fiber.interrupt(fiber));
    return result;
  });

// The server idle timeout the options ask for, or null for "off". Throws when it is not longer than the leader's loss detection (ADR-0045, decision 3).
export const serverIdleTimeoutOf = (options: LeaderOptions): Duration.Duration | null => {
  if (options.serverIdleTimeout === "off") return null;
  const timeout = Duration.fromInputUnsafe(options.serverIdleTimeout ?? "15 seconds");
  const bound = lossDetectionBound(options);
  if (!Duration.isGreaterThan(timeout, bound)) {
    throw new Error(
      `leader serverIdleTimeout (${Duration.toMillis(timeout)} ms) must be longer than the leader's own loss detection, failuresBeforeLost x (heartbeat + verifyTimeout) = ${Duration.toMillis(bound)} ms: otherwise the server could free the lock while the old leader still works`
    );
  }
  return timeout;
};

export interface LeaderHandle {
  readonly lockKey: bigint;
  // True until the leader is released on purpose or lost (its session died or stopped answering).
  isLeader(): boolean;
  // Is the lock still held right now? Asks Postgres, on the leader's own connection, whether this session holds the advisory lock: true if it does, false if it does not, the check fails or times out (and false once the
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
    // A configuration that breaks the safety rule is a defect, found on the first attempt.
    const idleTimeout = yield* Effect.try({ try: () => serverIdleTimeoutOf(options), catch: (error) => error }).pipe(Effect.orDie);
    const scope = yield* Scope.make();
    const reserveTimeout = Duration.fromInputUnsafe(options.reserveTimeout ?? "10 seconds");
    return yield* attempt(sql, lockKey, options, scope, reserveTimeout, idleTimeout).pipe(
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
  reserveTimeout: Duration.Duration,
  idleTimeout: Duration.Duration | null
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

    // On a replica nothing is taken: the CASE evaluates the lock only on a primary.
    const rows = yield* connection.execute(
      "SELECT CASE WHEN pg_is_in_recovery() THEN false ELSE pg_try_advisory_lock($1) END AS acquired",
      [lockKey.toString()],
      undefined
    );
    const acquired = Boolean((rows[0] as { acquired: boolean } | undefined)?.acquired);

    if (!acquired) return null;

    // The lease: from now on the server ends this session if it stays idle longer than this, and the heartbeat keeps it from being idle. If the setting
    // cannot be made the lock is given back, and the attempt fails and is retried.
    if (idleTimeout !== null) {
      yield* connection.execute(`SET idle_session_timeout = '${Duration.toMillis(idleTimeout)}ms'`, [], undefined).pipe(
        Effect.tapError(() => connection.execute("SELECT pg_advisory_unlock($1)", [lockKey.toString()], undefined).pipe(Effect.ignore))
      );
    }

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
        yield* within(verifyTimeout, connection.execute("SELECT pg_advisory_unlock($1), pg_notify($2, '*')", [lockKey.toString(), EVENTS_CHANNEL], undefined)).pipe(Effect.ignore);
        // The connection goes back to the pool, so without its lease: an idle pooled connection would otherwise be ended under the pool.
        if (idleTimeout !== null) {
          yield* within(verifyTimeout, connection.execute("RESET idle_session_timeout", [], undefined)).pipe(Effect.ignore);
        }
        yield* Scope.close(scope, Exit.void);
        if (monitor !== null) yield* Fiber.interrupt(monitor);
      });

    // Not `SELECT 1`: after the session is killed the pooled connection can come back on a NEW session that answers queries but
    // does not hold the lock (measured: the heartbeat failed once, then succeeded). Leadership is true only while THIS session
    // still holds the advisory lock, so ask Postgres exactly that.
    const alive: Effect.Effect<boolean> = within(
      verifyTimeout,
      connection.execute(
        `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()
         AND ((classid::bigint << 32) | objid::bigint) = $1::bigint AND NOT pg_is_in_recovery()`,
        [lockKey.toString()],
        undefined
      )
    ).pipe(
      Effect.map((rows) => Option.isSome(rows) && rows.value.length > 0),
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
