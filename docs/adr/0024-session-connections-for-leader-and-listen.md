# ADR-0024: The leader lock and LISTEN can use a connection of their own, so the rest can go through a pooler

## Status

**Accepted** (2026-10-09). Built: `SessionClients` (`@crablet/eventstore/SessionClients`), `Crablet.layer(pg, { session })`, the wallet's `WALLET_DB_SESSION_*`. Tested against the database's own bookkeeping
and, once, against PgBouncer 1.26 in Docker. Not tested against RDS Proxy or on AWS.

## Context

Two things in Crablet live on one connection for as long as a process holds a role: a module's **leader**, a session-level advisory lock taken on a connection reserved from the application's pool
(`Leader.ts`, ADR-0006), and **LISTEN**, on a connection `PgClient.listen` opens with the pool's own options (ADR-0005, ADR-0016). Everything else takes transaction-level locks and lives inside a transaction.

A connection pooler in transaction mode lends a server connection for one transaction. **Measured** (PgBouncer 1.26.0, `edoburu/pgbouncer`, `POOL_MODE=transaction`, a pool of 4 servers, Postgres 18 in Docker; one
run each, with a session-mode and a direct control that behaved as expected):

| | direct | PgBouncer, transaction mode |
|---|---|---|
| 40 concurrent commands through the real `CommandExecutor` | 0 failed | 0 failed |
| a view's batch and cursor in one transaction | works | works |
| leader: A holds the lock 6 s while a workload cycles server connections and B keeps trying (40 tries) | B never gets it | **B got it 24 times**; A's check said "lost" 38 of 40 times |
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
- `pgbouncer-session.diagnostic.ts` (needs Docker; not in CI): the wallet through PgBouncer in transaction mode, 15 commands each followed by a consistent read. With the split: 15 of 15 worked, p50 61 ms,
  p95 154 ms, the three leader locks each held by one backend throughout. Everything pooled: 15 of 15 failed, p50 5.0 s (the wait's limit). Note that in this control the lock's holder looked stable
  (one backend each), so a stable holder does not show that the leader works; the failure here showed in the views never catching up.

## Consequences

- **The pods need a route and a credential to the direct endpoint.** If the database only accepts the pooler, this is not possible, and RDS Proxy's pinning is what is left.
- One more setting, and a second pool on the database side. **It must hold what the process keeps for good: 7 connections for the three modules (3 leader locks, 3 `LISTEN` for event wake-ups, 1 for view progress), because with `@effect/sql-pg@4.0.0` each `listen` takes a pooled connection for as long as it lasts.** The default of 10 is enough; 5, which this ADR first said, is not (see "Correction").
- A failover of the direct endpoint drops those connections; the leader notices through its heartbeat and LISTEN reconnects with a wake-up, as before. Tested locally, not against Aurora.
- It does not help Aurora Limitless, which supports neither LISTEN nor RDS Proxy.
- Read replicas are a separate decision and are not part of this: LISTEN and the leader must be on the writer, and nothing here sends reads elsewhere.

## Alternatives considered

- **A lease table for the leader, and polling instead of LISTEN.** Would work through any pooler with no extra URL. Not built: the leader would need a fencing story of its own, wake-ups would be lost, and the direct
  connection is cheap where the network allows it.
- **Redis for the lock and the wake-ups.** A lease with a TTL has the same fencing problem and a failover of its own; a pub/sub message is at-most-once like NOTIFY. It adds a service and does not remove the need
  for the cursor to decide. Analysed, not built.
- **Session-mode pooling for the whole application.** Works (the control passed), but gives up the multiplexing the pooler is there for: each client connection holds a server connection.

## Correction (2026-10-09, same day): the session pool must be at least 7

The first version of this ADR, the guide and the wallet's default said the session pool needed "at most three" connections (one per module that leads) and that LISTEN used a connection "outside the pool", so 5 would do. That came from reading `@effect/sql-pg` under `node_modules/.old_modules-*`, an older copy, instead of the version in use (`4.0.0`, with its own `PgPool` built on Effect's `Pool`): there `pg.listen(channel)` reserves a **pooled** connection for as long as the LISTEN lasts. The repository's own guide ("Size the pool") already said it: a leader holds 7 connections for good, a follower 4. A process holds, in its session pool, 4 LISTENs (one per module's wake-ups, one for the views' progress hub) and up to 3 leader locks.

Found by the end-to-end test behind PgBouncer (`pgbouncer-e2e.test.ts`): two instances, the session connection of every leader killed under load. In the three runs of the first version, one role never got a leader back (the outbox, then the automations, then the outbox again, with 60 s observed): with a pool of 5, 4 slots went to LISTENs and the other roles' `reserve` waited for ever, silently, without even logging. The same run with no pooler and no split, or with the split and a pool of 12, recovered all three roles in 1.5 to 4.6 s (2 runs each at 5 and 12; the low-level test, three leaders on one client with the pool at 5 and at 10, 16 rounds, recovered 48 of 48).

What changed: the wallet's default is 10, the layer warns below 7, and `tryAcquireGlobalLeader` no longer waits for ever for a connection: after `reserveTimeout` (10 s) it fails with a message that names the pool (`leader-pool-exhausted.test.ts`), and it now gives the connection back when its first statement fails or when it is interrupted (before, either left the pool one connection short for good).

