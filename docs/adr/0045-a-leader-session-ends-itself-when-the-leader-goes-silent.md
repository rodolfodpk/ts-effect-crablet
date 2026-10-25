# ADR-0045: The leader's lease is its session: Postgres ends a lock session the leader stopped talking on

## Status

**Proposed** (2026-10-25). Built in `Leader.ts`, tested against Postgres 18.6, a replica and the kind lab (see "Progress"); still Proposed until AWS
has been run, and until the takeover's spread in the lab (19 to 34 s) is understood. It answers the follow-up ADR-0022 and the kind lab named: after a silent network partition the leader
lock is freed only when Postgres's TCP keepalives give up (388 s with the settings RDS ships).

## Context

Each module elects one leader with a session-level advisory lock on a connection the leader keeps (ADR-0006, ADR-0024). The lock lives as long as the
backend session that took it.

**The two sides find out at different times.** After a partition with no FIN or RST (a node's network gone, a security group change, a NAT that forgets
the flow):

- **The leader knows within seconds.** Its heartbeat asks, every second on its own connection, whether this session still holds the lock; a check that
  does not answer in 2 seconds fails, and two failures in a row make the leader lost (`Leader.ts`). The processor's fence (`verify`) fails closed
  before any batch at the first failed check. Worst case with the defaults: about 6 seconds after the cut, the old leader has stopped.
- **Postgres does not know.** For the server the session is idle, waiting for its client, and it holds the lock until the kernel declares the
  connection dead: `tcp_keepalives_idle + interval × count`. The kind lab measured the takeover at about 28 s with keepalives 10/5/3, 18 s in three of
  four runs with `tcp_user_timeout` added, and **388 s with the RDS defaults (300/30/2)**. During that time no instance leads: the views do not move, the
  automations do not run, the outbox does not publish.

So the gap is not on the client. It is the server holding a lock for a client that has already given it up.

**What Postgres offers for that.** `idle_session_timeout` (Postgres 14 and later) ends a session that has been idle, waiting for a client command
outside a transaction, longer than the setting. Its context is `user` (checked: `pg_settings.context`): a session can set it for itself, with no superuser and no parameter
group. That should hold on RDS, where the application's role can set `user` settings; it was not tried there. When it fires the backend exits, and its session-level locks go with it.

**Tried by hand** (Postgres 18.6 in Docker; a TCP proxy between the "leader" and the server that, on the cut, stops forwarding in both directions
without closing either side; the leader sends the heartbeat query every second; a probe on a direct connection watches `pg_locks`):

| The lock session | After the cut |
|---|---|
| no `idle_session_timeout` | the lock was **still held 40 s** after the cut (the test stopped there; the keepalives would decide) |
| `SET idle_session_timeout = '10s'` | the lock was **freed 10.1 s** after the cut |
| `SET idle_session_timeout = '2s'`, heartbeat every 1 s | held through 3 s of heartbeats (a live leader is never idle that long); **freed 2.0 s** after the cut |

## Decision (proposed)

**The lock session sets `idle_session_timeout` for itself when it takes the lock. The heartbeat renews it every second; if the leader goes silent,
Postgres ends the session after the timeout, the lock is freed, and a follower takes it at its next attempt.** The lease is the session itself, renewed
by the heartbeat and enforced by the server: no table, no expiry column, no clock compared between machines.

1. **Set on acquiring, on the lock session only.** Right after `pg_try_advisory_lock` succeeds, the leader runs `SET idle_session_timeout = '<n>ms'`
   on the same connection. A follower's attempt that fails sets nothing (its connection goes back at once). The `LISTEN` connections are never given
   it: they are idle by nature and would be ended and reconnected every few seconds.
2. **Reset on release.** After the statement that unlocks and notifies, the release runs `RESET idle_session_timeout` on the same connection, bounded
   by the same timeout and ignored on a dead connection like the unlock, so a connection that goes back to the pool does not carry it (an idle pooled connection would otherwise be ended under the pool). A connection whose release fails is dead and is not
   reused.
3. **The timeout must be longer than the leader's own loss detection.** The safety rule: the old leader must have stopped before the server frees the
   lock, or two instances believe they lead. With the heartbeat's settings the leader is lost after at most
   `failuresBeforeLost × (heartbeat + verifyTimeout)` (6 s with the defaults). The timeout is `LeaderOptions.serverIdleTimeout`, **default 15 seconds**,
   and building a leader refuses one that is not longer than that bound. `off` keeps today's behavior (the keepalives decide).
4. **Takeover bound.** After a silent partition a follower leads within `serverIdleTimeout + leaderElectionRetryIntervalMs`: about 20 s with the
   defaults, against 388 s with the RDS keepalives, and independent of the network stack's settings.
5. **Work that overlaps is already allowed for.** The timeout bounds when a second leader can start; it does not make work exactly once. A batch the
   old leader started before the cut can still be running, and that is the case every processor is already built for: a view's batch commits only if
   its cursor did not move (ADR-0023, ADR-0032), an automation's command is idempotent and backstopped (ADR-0034, ADR-0035), an outbox publisher gets a
   stable message id (ADR-0036), a deadline is recorded once (ADR-0043). Nothing here changes those.
6. **A leader leads only on a primary.** Advisory locks are not replicated: after a failover (RDS Multi-AZ, Aurora) every session drops and the
   election starts again on the new writer. But a client that reconnects through a cached DNS name can land on the old writer, now a replica, where an
   advisory lock can still be taken (to be confirmed by a test): it would "lead" where every write fails, while another instance leads on the writer.
   So taking the lock asks `pg_is_in_recovery()` first and takes nothing on a replica (`CASE WHEN pg_is_in_recovery() THEN false ELSE
   pg_try_advisory_lock(...) END`), and the heartbeat's check requires it too: a session that finds itself on a replica is a lost leader. This holds
   for any way of electing a leader, the lease of the alternatives included.
7. **A check that does not answer in time has failed, without waiting for the driver.** Found while building this: on a half-open connection,
   interrupting a statement makes `@effect/sql-pg` send a cancel request on a side connection and wait for the statement to drain, up to 5 seconds
   more, and `Effect.timeout` waits for that interruption. The heartbeat's check that should fail after `verifyTimeout` failed about 5 seconds later, so
   the leader knew after 5.9 s instead of 1.4 s with the test's settings (about 9 s instead of 6 with the defaults). The check, the unlock and the reset
   now wait at most their timeout and leave the interruption to run in the background, so decision 3's bound is the real one.
8. **Keepalives stay a complement.** The guide keeps recommending shorter server keepalives (and `tcp_user_timeout`) where they can be set: they also
   free the backend slot of a dead client. They are no longer what bounds the takeover.

## Progress (2026-10-25)

- **Built** in `Leader.ts`: `serverIdleTimeout` (default 15 s, `off`), refused when not longer than `lossDetectionBound` (a unit test); the `SET` once
  the lock is held and the `RESET` on release; the primary check when taking (`CASE WHEN pg_is_in_recovery() ...`) and checking the lock; the bounded
  wait of decision 7. Unit tests (`leader-session.test.ts`) check the statements' order against a stand-in connection.
- **Measured** in `packages/eventstore/test/integration/leader-partition.test.ts` (Postgres 18.6, an in-process proxy that cuts silently, the test's
  settings: heartbeat 200 ms, check 500 ms, 2 failures, so a bound of 1.4 s, and a server timeout of 3 s): the leader knew after **1.42 s**, the
  follower led after **3.04 s**, after the leader had stopped. With `off` the follower never led within 6 s. A leader that keeps its heartbeat kept
  its lock through 8 s with a 2 s timeout. A connection given back to the pool shows `idle_session_timeout` 0. Without the `SET` (a mutation) no
  follower led, and the test fails.
- **A replica** (`leader-replica.test.ts`, a primary and a streaming replica in one container): on a hot standby `pg_try_advisory_lock` **does**
  succeed, so decision 6 is needed and not only a precaution; the leader's attempt takes nothing there and leads on the primary; the heartbeat's
  query says a session holding the lock on a replica does not lead. Without the `CASE` (a mutation) the test fails.
- **Configurable by an application:** every module takes `leader?: LeaderOptions` and passes it to its lock (before, the modules called
  `tryAcquireGlobalLeader` with no options, so `serverIdleTimeout` could not be set).
- **A busy leader keeps a tight lease** (`leader-lease-under-load.test.ts`): the whole wallet with a 7 s timeout, just over the 6 s loss detection,
  and 60 s of deposits (5813 accepted): no module changed its leader session.
- **The kind lab** (2026-10-25; the views' leader cut off with iptables drops, takeover read from `pg_locks`; nothing acknowledged lost in any run):

  | Scenario | Before (keepalives only) | With the session's timeout |
  |---|---|---|
  | `partition-tuned` (keepalives 10/5/3) | 13, 28, 29, 28 s | **19 s** (one run) |
  | `partition-rds` (keepalives 300/30/2) | **388 s** | **34, 33, 33, 19 s** (four runs) |

  The server frees the lock at about 15 s, as in the integration test; the takeover then took either about 4 s more (one retry interval) or about
  18 s more. Where the extra 14 s goes is not established: it is on the followers' side, and one candidate is an attempt waiting for a session
  connection (`reserveTimeout`, 10 s). The first `partition-rds` run (34 s) also included pulling the debug image, after the clock started.
- **Not done:** the cause of the 33 s runs, and AWS.

## Alternatives considered

- **A lease table** (`crablet_leases(module, holder, fencing_token, expires_at)`, renewed by the leader, taken by a follower once expired). The common
  design, and it would also work behind a pooler in transaction mode. Rejected for now: a write per module per heartbeat, expiry decided by comparing
  clocks of different machines (or by the database's clock, one more round trip), and a fencing token every module would have to carry into its writes
  to be safe, which the advisory lock and the per-batch fence already give. If the advisory lock itself has to go (a pooler that cannot carry a
  session), this is the replacement, and it deserves its own record.
- **Only tune the keepalives** (`tcp_keepalives_*` and `tcp_user_timeout` on the server or the connection). Measured to help (28 s, 18 s), but each
  deployment has to set it, RDS needs a parameter group, a client-side keepalive does nothing for the server's view, and the bound still depends on
  the network stack. Kept as a complement (decision 6).
- **A follower that ends the stale holder** (`pg_terminate_backend` on the lock holder whose session has not run a query for N seconds,
  `pg_stat_activity.state_change`). Same bound, but it needs `pg_signal_backend` (a role grant), and it moves the decision of who is dead into every
  follower. The server's own timer is simpler and needs no privilege.
- **`statement_timeout` or `idle_in_transaction_session_timeout`.** Neither applies: the lock session is idle between heartbeats, not in a statement
  and not in a transaction.

## Consequences

- A silent partition costs about 20 s of no leader instead of up to 388 s on RDS, with no setting for the deployer to get right.
- A leader that is alive but stalled for longer than the timeout (a frozen event loop, a stop-the-world pause, a very slow pod) loses its lock. That is
  the intended trade: its own heartbeat would have called it lost sooner, and a follower takes over.
- One more option on `LeaderOptions`, with a rule checked at construction. Each module passes it as it passes the others.
- Postgres 14 or later, already required (the project targets 18).
- Behind PgBouncer in session mode the `SET` stays on the server connection until the pooler resets it (`server_reset_query`, `DISCARD ALL` by
  default); the `RESET` on release makes that moot. RDS Proxy already pins a session that holds an advisory lock (ADR-0024).

## Before accepting

- **Built in `Leader.ts`:** the `SET` after acquiring, the `RESET` on release, the primary check when taking and checking the lock, `serverIdleTimeout` with its default and the construction
  check (a unit test of the rule).
- **An integration test of the partition** (Testcontainers, no kind): an in-process TCP proxy on each instance's lock connection that can cut silently,
  as in the experiment above. Two instances lead and follow; cutting the leader's proxy makes the follower lead within `serverIdleTimeout +` the retry
  interval; the old leader's `isLeader()` turned false before the follower took the lock. The same test with `off` shows the lock still held at the end
  of the bound.
- **A live leader keeps its lock** under the wallet's load for several minutes with a short timeout (the heartbeat renews it).
- **A released connection does not carry the setting** (`SHOW idle_session_timeout` on the next use of a pooled connection).
- **The kind lab's `partition-rds` scenario rerun**, expecting the takeover near 20 s instead of 388 s.
- **A replica takes no lock and keeps none:** against a hot standby (a streaming replica in Docker), taking the lock answers "not acquired", and a
  leader whose session finds itself on a replica is lost.

## Then, on AWS

What no local test reproduces, run with the kind lab's scenarios and checks (nothing acknowledged lost, one leader per module) before relying on it in
production:

- **RDS PostgreSQL**: the silent partition with the RDS keepalives (the `partition-rds` scenario), expecting about 20 s; and that the application's
  role can `SET idle_session_timeout`.
- **RDS Multi-AZ failover** (a reboot with failover): every module leads again on the new writer, and no instance leads on the old one.
- **Aurora PostgreSQL failover**: the same, with the cluster endpoint; and a client that keeps resolving the old writer is refused leadership there
  (decision 6).
- **RDS Proxy**, if it is in the path: the lock session's `SET` pins it (it is pinned already), and a partition between the application and the proxy
  frees the lock after the timeout.

If one of these fails in a way the session cannot handle, or the lock session has to go through a pooler in transaction mode, the lease table of the
alternatives is the next step, behind the same `LeaderHandle` (`acquireLeader` is injected into every processor), in a record of its own.
