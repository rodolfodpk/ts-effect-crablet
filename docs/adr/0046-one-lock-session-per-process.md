# ADR-0046: One lock session and one LISTEN connection per process

## Status

**Accepted** (2026-10-25). Built in `Leader.ts` and `SharedListen.ts`, tested against Postgres and run in the kind lab (see "Result").

## Context

Each module elects its leader with a session-level advisory lock, and each took it on a connection of its own (ADR-0006): a process that leads the
views, the automations, the outbox and the deadlines held four connections for its locks, each with its own heartbeat, beside one `LISTEN` per module
and one for the views' progress hub. Measured on the wallet (ADR-0022): a leader of three modules held 7 of the default 10 connections for good; the
deadlines (ADR-0043) made it 8 with four modules. ADR-0022's follow-ups name it: "fewer held connections per process: one `LISTEN` connection and one
lock session per process instead of one per module".

A session holds any number of advisory locks, so nothing requires a connection per lock. What a module needs from its lock is the same as before: to
lead alone, to know within seconds that it no longer does, and to give the lock back on its own.

## Decision

1. **One session per process holds the locks of every module that leads there.** `tryAcquireGlobalLeader(sql, key, options)` takes the lock on a
   connection shared by every leader of the same `SqlClient` and the same `LeaderOptions`; the connection is reserved when the first lock is taken and
   given back when the last one is released. An attempt that finds no lock held reserves it, tries, and gives it back if it got nothing, as before.
2. **A key this session already holds is refused.** Session-level advisory locks are re-entrant: the same session taking the same key twice gets it
   twice. Two leaders of one module in one process (two processors over one client, as a test does) must not both lead, so the session answers "not
   acquired" for a key it holds.
3. **One heartbeat for all of them.** Every `heartbeat`, one query lists the keys this session holds (`pg_locks`, `pid = pg_backend_pid()`, and
   `NOT pg_is_in_recovery()`, ADR-0045); each module's leader is checked against that list, with the same rule as before (`failuresBeforeLost` failed
   checks in a row make it lost). A check that does not answer in time fails every leader of the session: they lost it together, as they would have
   with a connection each in the same partition. A lost session is released and the next attempt reserves a new one.
4. **The lease is set once.** The session sets `idle_session_timeout` when it takes its first lock and resets it when it gives the last one back
   (ADR-0045). The rule that it outlasts the loss detection holds as before, since all its leaders share the options.
5. **Releasing one lock leaves the others.** A module that stops unlocks its key and announces it (`pg_notify`, as before); the session keeps the others.
   `verify` (the processor's fence) asks about its own key.
6. **One `LISTEN` connection per process.** `@effect/sql-pg` fans one channel out to every listener of it on one connection, but `listen` on a pool
   reserves a new connection each time. So every `LISTEN` of a process on one `PgClient` (the modules' wake-ups and the views' progress hub) runs on
   one connection of its own, opened with the client's settings (`PgConnection.make(pg.config)`, outside the pool), pinned once, opened by the first
   listen and closed with the last (`sharedListen`). When it is lost, every queue on it fails, as each `LISTEN`'s did on its own connection: each
   stream reconnects and announces a wildcard (ADR-0021), and the first to listen again finds the connection gone and replaces it once; the others
   listen on the new one. (Added 2026-10-25; the first version of this ADR left it for later.)
7. **Counting.** A process counts one held session connection for its locks however many modules lead there (`holdSessionOnce`). Its `LISTEN`
   connection is not in the pool, so the pool warning does not count it; the server sees it beside the pool.
8. **An attempt's statements are bounded.** An attempt at a lock (and the lease set with the first one) runs on the shared session under its permit, so
   a statement that does not answer (a silent partition) would hold every leader of the process with it. It gets `verifyTimeout`; with no answer, the
   session is abandoned: every leader on it is lost, the attempt fails, and the connection is given back only after the late statement has been
   interrupted, which retires it, so a lock it may have taken goes with it. (Added 2026-10-25, found in the kind lab: see "Result".)

## Consequences

- A process that leads four modules holds one connection for their locks instead of four, and one for its `LISTEN`s instead of one per module and one
  for the hub: the wallet's leader of three modules holds 2 for good instead of 7, a follower 1 instead of 4, and adding the deadlines adds none. The
  server sends each notification of `crablet_events` once per process instead of once per module. The pool-sizing guidance changes accordingly: one
  connection beside the pool.
- Statements of the modules' leaders take turns on one connection: a heartbeat and a few attempts per interval, all short.
- One stall loses every module's leadership in the process at once, where separate connections could in principle have lost one; in a partition they
  were lost together anyway.
- Options must match to share: a module given different `LeaderOptions` gets a session of its own.
- A lost `LISTEN` connection costs every stream of the process a reconnect and a wildcard together, where separate connections could have lost one.

## Result (2026-10-25)

- **Built** in `Leader.ts`: the sessions of a client, by options, each changed under a permit; one heartbeat query listing the keys the session holds;
  the re-entrancy guard; the lease set with the first lock and reset with the last; `holdSessionOnce` counts the lock session once per process.
- **Tested against Postgres** (`leader-shared-session.test.ts`): four modules leading in one process hold their four locks on one session (one `pid`
  in `pg_locks`, one connection of the process), and another process gets none of them; a second leader of a module in the same process is refused
  (without the guard, a mutation, it leads twice and the test fails); releasing one lock keeps the others; terminating the session loses all four
  together, and the next attempt leads on a new session. Unit tests: one reservation for two leaders, the connection returned with the last lock, the
  lease set and reset once, different options not shared.
- **What changed in other tests:** `leader-pool-exhausted.test.ts` filled a pool of two with two leaders; they now share one connection, so it fills the
  pool with plain reservations instead. The whole integration suite passes.
- **The shared `LISTEN`** (decision 6): unit tests of `makeSharedListener` with fake connections (listens on two channels share one connection, closed
  with the last; a lost connection is replaced once, by the first listen after it, and the others use the new one; a connection that cannot be opened
  fails that listen and the next one tries again; two mutations, no replacement and no closing, each fail a test). Against Postgres
  (`listen-notify.test.ts`): three wake-up streams on `crablet_events` and one on another channel hold one `LISTEN` backend, each hears its own, and
  after that backend is terminated all four announce a wildcard and hear again on one new backend. The wallet's `session-clients.test.ts` now finds
  one lock session and one `LISTEN` connection for the three modules and the hub (it found 4 `LISTEN`s); the course feed's tests find the hub's
  `LISTEN` on the process's one connection (its session shows whichever `LISTEN` came last).
- **The kind lab** (2026-10-25, this build, a quiet host): `partition-rds` 18, 19 and 18 s, `partition-tuned` 19 s, `kill` 0.4 s, `rolling` with no
  lag; nothing acknowledged lost (ADR-0045's "Progress" has the earlier rounds).
- **Found by the lab** (decision 8): in a pod cut off from Postgres, an attempt at another module's lock had no bound on the shared session and logged
  `Query cancellation timed out` long after the cut; meanwhile it held the session's permit, so the lost leaders' release and the session's
  replacement waited on it. Before this ADR each attempt had a connection of its own. `leader-partition.test.ts` now cuts a shared session and tries
  for another key: the attempt fails within `verifyTimeout` (0.7 s with its settings) and the leader on the session is lost; without the bound (a
  mutation) the attempt hangs and the test times out.
- **Found by CI** (2026-10-25): after a session was terminated, an attempt could run on it in the moment between its leaders being lost and their
  release giving it back, and fail with the server's error instead of leading on a new session (`leader-shared-session.test.ts`, on CI only). An
  attempt now takes a new session when every leader on the current one is lost, and a statement that fails on a session holding locks loses its
  leaders, as one that does not answer does. Reproduced since (2026-10-26, `leader-shared-session-race.test.ts`): 40 rounds of terminating the
  session and attempting the moment a leader is seen lost. Without the guard (a mutation) an attempt failed with the server's error in 3 runs of 3,
  at rounds 0 to 5; with it, 0 in 6 runs. The second half has a test of its own: an attempt on a session that died before the heartbeat noticed
  fails and loses every leader on it at once, and the next attempt leads on a new session; without `loseAll` on the failure (a mutation) the
  leaders stay leading until the heartbeat. Since 2026-10-27 that attempt does not fail: once its failure has lost the session's leaders, it is made
  again at once on a new session, so the module leads again without waiting for its retry interval (5 s by default). Only that case is retried: a
  failure on a new session, or a statement that did not answer, says the database is unreachable, and the error goes to the module as before. The
  test now checks that the attempt leads on a new session; without the retry (a mutation) it fails.

## Alternatives considered

- **Keep a connection per lock.** Simple, and each module fails over alone. Rejected: it costs a held connection per module for no gain in a failure
  where they all go together, and it is what made the deadlines' lock cost a connection.
- **A process-wide leader for all modules (one lock).** One election, but a module could no longer lead in another process than the others, which
  ADR-0022's roles and independent failover rely on.
