# ADR-0045: The leader's lease is its session: Postgres ends a lock session the leader stopped talking on

## Status

**Proposed** (2026-10-25). Nothing built. It answers the follow-up ADR-0022 and the kind lab named: after a silent network partition the leader lock
is freed only when Postgres's TCP keepalives give up (388 s with the settings RDS ships). The mechanism was tried by hand against Postgres 18.6
(below); the decision is to be accepted when the tests in "Before accepting" exist and pass.

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
6. **Keepalives stay a complement.** The guide keeps recommending shorter server keepalives (and `tcp_user_timeout`) where they can be set: they also
   free the backend slot of a dead client. They are no longer what bounds the takeover.

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

- **Built in `Leader.ts`:** the `SET` after acquiring, the `RESET` on release, `serverIdleTimeout` with its default and the construction
  check (a unit test of the rule).
- **An integration test of the partition** (Testcontainers, no kind): an in-process TCP proxy on each instance's lock connection that can cut silently,
  as in the experiment above. Two instances lead and follow; cutting the leader's proxy makes the follower lead within `serverIdleTimeout +` the retry
  interval; the old leader's `isLeader()` turned false before the follower took the lock. The same test with `off` shows the lock still held at the end
  of the bound.
- **A live leader keeps its lock** under the wallet's load for several minutes with a short timeout (the heartbeat renews it).
- **A released connection does not carry the setting** (`SHOW idle_session_timeout` on the next use of a pooled connection).
- **The kind lab's `partition-rds` scenario rerun**, expecting the takeover near 20 s instead of 388 s.
