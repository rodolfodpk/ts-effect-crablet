# Configure it

*Guide · operators deploying an application · [Run it in production](run-in-production.md) read · 15 minutes*

The decisions to make before a first deployment, in order, with a value to start from. Every option is listed in the
[configuration reference](../../reference/configuration.md); the measurements behind the starting values are in [Run it in production](run-in-production.md).

## 1. One process, or a deployment per role

| Choose | When |
|---|---|
| One process (`WALLET_ROLES=all`, the default) | One or a few instances. Every instance serves commands and reads; one of them leads each module. |
| A deployment per role (`api`, and `views,automations,outbox` as workers) | You want to scale the API apart from the background work, or put the API behind a pooler. |

Either way, run at least two instances, so a follower is ready to take over each module ([background processors](../../concepts/background-processors.md)).

## 2. The pool

Start from **what is held for good, plus the commands you want at once**. A process that leads all three modules holds 7 connections for good; a
follower holds 4; an API-only process holds 1. Then check the fleet: *instances × pool* must stay under the server's `max_connections`, with room for
migrations and monitoring. Running out is quiet: commands fail and nothing in the logs says why ([size the pool](run-in-production.md#size-the-pool)).

## 3. A pooler, or not

| Your setup | Do |
|---|---|
| A few long-lived instances | Connect directly. A pooler gains nothing. |
| Many short-lived clients, PgBouncer in transaction mode, or RDS Proxy | Send the API through the pooler, and give the leader locks and `LISTEN` a direct connection (`session` in `Crablet.layer`, `WALLET_DB_SESSION_HOST` in the wallet) ([behind a pooler](run-in-production.md#behind-a-pooler-pgbouncer-rds-proxy)). |

## 4. Polling and wake-ups

Start with the defaults: wake-ups `coalesced`, poll every 1 s, back off to at most 10 s when idle. They are the defaults of the modules too, so a module needs no `config` at all ([polling settings](../../reference/configuration.md#polling-settings)). With wake-ups working, a write reaches a view in
tens of milliseconds whatever the polling settings; they only matter when a wake-up is lost or turned off
([three measured profiles](run-in-production.md#polling-and-wake-ups)).

## 5. Leader takeover

`leaderElectionRetryIntervalMs` (5 s by default) bounds the takeover after a crash. A silent network partition takes the leader's `serverIdleTimeout`
more (15 s by default; each module's `leader: { serverIdleTimeout }` option, a `LeaderOptions`): the leader's lock session sets `idle_session_timeout` for itself, so the server ends it once the
leader has gone silent and frees the lock, whatever the TCP keepalives say ([ADR-0045](../../adr/0045-a-leader-session-ends-itself-when-the-leader-goes-silent.md)).
It must be longer than the leader's own loss detection (6 s with the defaults), which is checked. Setting the server's TCP keepalives
(`tcp_keepalives_idle`, `_interval`, `_count`) shorter is still worth it, for the backend slots of clients that are gone
([failure modes](failure-modes.md#a-leader-loses-the-network)).

## 6. Reads

The default is strict: a read waits up to 5 s for the views and answers `503` if they are behind. Keep it unless a page would rather show stale data
than an error; then make that endpoint `bounded` ([read consistency](../../reference/http.md#read-consistency)).

## 7. Migrations

With more than one instance, apply migrations in a pre-deploy job, not at start-up: five pods applying at once failed in the kind lab, and Flyway with
its lock passed three times out of three ([apply the migrations](run-in-production.md#1-apply-the-migrations)).

## 8. Observability

Export the metrics (`OTEL_EXPORTER_OTLP_ENDPOINT` in the wallet), load the dashboard and its alerts, and keep the [runbooks](runbooks.md) next to
them ([See it on a dashboard](dashboard.md)).
