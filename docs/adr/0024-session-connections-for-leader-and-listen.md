# ADR-0024: The leader lock and LISTEN can use a connection of their own, so the rest can go through a pooler

## Status

**Accepted** (2026-10-09). Built: `SessionClients` (`@crablet/eventstore/SessionClients`), `Crablet.layer(pg, { session })`, the wallet's `WALLET_DB_SESSION_*`. Tested against the database's own bookkeeping
and, once, against PgBouncer 1.26 in Docker. Not tested against RDS Proxy or on AWS.

## Context

Two things in Crablet live on one connection for as long as a process holds a role: a module's **leader**, a session-level advisory lock taken on a connection reserved from the application's pool
(`Leader.ts`, ADR-0006), and **LISTEN**, on a connection `PgClient.listen` opens with the pool's own options (ADR-0005, ADR-0016). Everything else takes transaction-level locks and lives inside a transaction.

A connection pooler in transaction mode lends a server connection for one transaction. **Measured** (PgBouncer 1.26.0, `edoburu/pgbouncer` given the database's IPv4 address, `POOL_MODE=transaction`, a pool of 4 servers, Postgres 18 in Docker; one
run each, with a session-mode and a direct control that behaved as expected):

| | direct | PgBouncer, transaction mode |
|---|---|---|
| 40 concurrent commands through the real `CommandExecutor` | 0 failed | 0 failed |
| a view's batch and cursor in one transaction | works | works |
| leader: A holds the lock 6 s while a workload cycles server connections and B keeps trying (40 tries) | B never gets it | **B got it 11 times**; A's check said "lost" 40 of 40 times (and A no longer led at the end) |
| 20 notifications sent from a direct connection to a LISTEN | 20 of 20 | **0 of 20**, no error |

Both failures are silent: LISTEN reports success and hears nothing, and the leader flips between thinking it leads and not, while a second instance can take the same lock. The whole wallet with everything through
the pooler failed 15 of 15 commands followed by a consistent read (a 503 after the 5 s wait; the views never caught up; the cause was not examined further).

AWS documents (RDS Proxy, "Avoiding pinning") that LISTEN and session-level advisory locks **pin** a connection to the proxy and that transaction-level advisory locks do not. That is a different failure,
a cost in connections, and it does not break the lock.

## Decision

Name the connection those two need, and let the application point it at the database's own endpoint:

- `SessionClients` is an optional `Context.Reference` (`{ sql, pg }`, default `null`). `sessionSql` and `sessionPg` return it when it is there and the application's own client when it is not.
- The three modules (`ViewsModule`, `AutomationsModule`, `OutboxModule`) take their leader and their wake-up LISTEN from it; `ViewProgressHubLive` takes its LISTEN from it. Nothing else changes: the appends,
  the commands, the pollers' queries, the view's transaction and the `pg_notify` calls stay on the application's client, through the pooler.
- `sessionClientsLayer(config)` builds a second client, and `Crablet.layer(pg, { session })` provides it. The wallet reads `WALLET_DB_SESSION_HOST` and companions; unset, it provides nothing.
- Omitted, behaviour is exactly the old one: one connection for everything.

## Result

- `session-clients.test.ts`: the wallet is started with two clients that carry different `application_name`s, and `pg_locks` / `pg_stat_activity` say who holds what. The three leader locks and every LISTEN
  backend belong to the session client, and the application's backends hold none; a control without the session client finds all of it on the application's. Moving either the hub or one module's leader
  back to the application's client makes the first test fail.
- `pgbouncer-e2e.test.ts` (Docker and the `edoburu/pgbouncer` image; in the integration suite): two wallet instances behind PgBouncer in transaction mode (a server pool of 8), the application's connection through it and the leader locks and LISTEN direct. 190 commands through both (opens, deposits, withdrawals, transfers, a deposit id sent twice at once through both instances), the session connection of every leader killed in the middle, then instance A stopped gracefully under load. Required: one leader per role each time, always on a `session-*` connection and never on a pooled one; B takes all three roles after A stops; no 5xx; and the chaos page's consistency checks (`examples/chaos-ui/server/checks.ts`: views equal the sum of the log, no duplicate deposits, one welcome notification per wallet, audit and transaction view agree), with every processor caught up. It passed three runs in a row (about 11 s each); it fails with a session pool of 5 (the leaders do not come back) and with no session split (a leader lock held by a pooled connection).
- `pgbouncer-session.diagnostic.ts` (needs Docker; not in CI): the wallet through PgBouncer in transaction mode, 15 commands each followed by a consistent read. With the split: 15 of 15 worked, p50 47 ms,
  p95 88 ms, the three leader locks each held by one backend throughout. Everything pooled: 15 of 15 failed, p50 5.0 s (the wait's limit). Note that in this control the lock's holder looked stable
  (one backend each), so a stable holder does not show that the leader works; the failure here showed in the views never catching up.

## Consequences

- **The pods need a route and a credential to the direct endpoint.** If the database only accepts the pooler, this is not possible, and RDS Proxy's pinning is what is left.
- One more setting, and a second pool on the database side. **It must hold what the process keeps for good**, because with `@effect/sql-pg@4.0.0` each `listen` takes a pooled connection for as long as it lasts: 7 for all three modules (3 leader locks, 3 `LISTEN` for event wake-ups, 1 for view progress), 6 for the three workers without the api, 2 for one worker, 1 for the api. The caller states it (`sessionHolds`; the wallet computes it from its roles) and the layer logs a warning when the pool is smaller. The wallet's default is 10.
- A leader no longer waits for ever for a connection: after `reserveTimeout` (10 s) `tryAcquireGlobalLeader` fails with a message that names the pool, and it gives the connection back if its first statement fails or it is interrupted (`leader-pool-exhausted.test.ts`).
- A failover of the direct endpoint drops those connections; the leader notices through its heartbeat and LISTEN reconnects with a wake-up, as before. Tested locally, not against Aurora.
- It does not help Aurora Limitless, which supports neither LISTEN nor RDS Proxy.
- Read replicas are a separate decision and are not part of this: LISTEN and the leader must be on the writer, and nothing here sends reads elsewhere.

## Alternatives considered

- **A lease table for the leader, and polling instead of LISTEN.** Would work through any pooler with no extra URL. Not built: the leader would need a fencing story of its own, wake-ups would be lost, and the direct
  connection is cheap where the network allows it.
- **Redis for the lock and the wake-ups.** A lease with a TTL has the same fencing problem and a failover of its own; a pub/sub message is at-most-once like NOTIFY. It adds a service and does not remove the need
  for the cursor to decide. Analysed, not built.
- **Session-mode pooling for the whole application.** Works (the control passed), but gives up the multiplexing the pooler is there for: each client connection holds a server connection.

## History of this decision

Two things in the first version were wrong and were corrected the same day; the text above is the corrected one.

- **Pool size.** The first version said the session pool needed three connections and that `LISTEN` used one outside the pool, so 5 would do. It came from reading an older copy of `@effect/sql-pg` under `node_modules/.old_modules-*`. In the version in use, `listen` reserves a pooled connection. The end-to-end test, killing every leader's session connection under load, found it: with a pool of 5, one role never got a leader back (60 s observed); with 12, or with the split and no pooler, all three came back in 1.5 to 4.6 s.
- **The first PgBouncer numbers.** They were taken with `host.docker.internal`, which also resolves to IPv6 on Docker Desktop; PgBouncer tried it first and waited `server_login_retry` (15 s), so it ran with one server connection and no transactions ever competed. Redone with the IPv4 literal, the commands, the views' batch and LISTEN came out the same; the leader row changed (see the table). The end-to-end test now requires that the pooler really ran transactions side by side, and with that contention it found a bug in the wallet unrelated to pooling (NOTES.md, "the statement opening").
