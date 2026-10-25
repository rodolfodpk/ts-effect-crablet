# ADR-0046: One lock session per process, shared by the modules' leaders

## Status

**Proposed** (2026-10-25). Built in `Leader.ts` and tested (see "Result"); to be accepted once it has run in the kind lab. The `LISTEN` half of the
follow-up is not built (decision 6).

## Context

Each module elects its leader with a session-level advisory lock, and each took it on a connection of its own (ADR-0006): a process that leads the
views, the automations, the outbox and the deadlines held four connections for its locks, each with its own heartbeat, beside one `LISTEN` per module
and one for the views' progress hub. Measured on the wallet (ADR-0022): a leader of three modules held 7 of the default 10 connections for good; the
deadlines (ADR-0043) made it 8 with four modules. ADR-0022's follow-ups name it: "fewer held connections per process: one `LISTEN` connection and one
lock session per process instead of one per module".

A session holds any number of advisory locks, so nothing requires a connection per lock. What a module needs from its lock is the same as before: to
lead alone, to know within seconds that it no longer does, and to give the lock back on its own.

## Decision (proposed)

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
6. **`LISTEN` stays one connection per module, for now.** `@effect/sql-pg` fans one channel out to many listeners on one connection, but `listen` on a
   pool reserves a new connection each time. Sharing it needs a client over one connection for the process's listens, or a fan-out of our own, which is
   a change of its own (the wake-ups' reconnect and resync behavior, ADR-0021) and is left for one.
7. **Counting.** A process counts one held session connection for its locks however many modules lead there (`holdSession`), and one per `LISTEN`.

## Consequences

- A process that leads four modules holds one connection for their locks instead of four: the wallet's leader of three modules holds 5 for good instead
  of 7 (one lock session, three `LISTEN`s, the hub's), and adding the deadlines adds none. The pool-sizing guidance changes accordingly.
- Statements of the modules' leaders take turns on one connection: a heartbeat and a few attempts per interval, all short.
- One stall loses every module's leadership in the process at once, where separate connections could in principle have lost one; in a partition they
  were lost together anyway.
- Options must match to share: a module given different `LeaderOptions` gets a session of its own.

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

## Alternatives considered

- **Keep a connection per lock.** Simple, and each module fails over alone. Rejected: it costs a held connection per module for no gain in a failure
  where they all go together, and it is what made the deadlines' lock cost a connection.
- **A process-wide leader for all modules (one lock).** One election, but a module could no longer lead in another process than the others, which
  ADR-0022's roles and independent failover rely on.
