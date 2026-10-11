# Failure modes

*Guide · operators · [background processors](../../concepts/background-processors.md) read · 10 minutes*

What happens when something breaks, what you see, and what you do. Each row was observed in the [kind lab](run-the-kind-lab.md) or in the
[reliability report](../../history/plans/reliability-and-scale-diagnostic.md); the numbers are from a laptop, so take them as an order of magnitude.

## A leader stops or dies

| What happens | What follows | What you see |
|---|---|---|
| A graceful stop (a rolling update, `SIGTERM`) | The lock is released and a follower takes over in about 0.1 s. In the lab a rollout under load left the views' lag at 0. | Nothing, beyond the leadership series moving to another instance. |
| The process or its pod is killed | Postgres sees the connection close and frees the lock; a follower takes it at its next retry. In the lab: 0.4 s, nothing lost. | `crablet.poller.leadership` moves to another instance. |
| Its node is lost | The same: under 1 s in the lab. Commands served by an API pod on that node fail. | A few failed commands; leadership moves. |

With only one instance, nothing takes over: the module's work waits until the instance is back. Run at least two.

## A leader loses the network

If the leader cannot reach Postgres and no reset arrives (a silent partition), Postgres frees the lock only when it gives up on the connection. Until
then the module does not move: views fall behind by the takeover time, and strict reads answer `503`.

| Postgres TCP keepalives | Takeover in the lab |
|---|---|
| 10 / 5 / 3 | 13 to 29 s |
| the same, plus `tcp_user_timeout=15000` on the client | 18 to 38 s |
| 300 / 30 / 2 (what RDS ships) | 388 s |

The stale leader cannot do harm meanwhile: it checks that its own session still holds the lock before each batch and each cursor move. Set the
keepalives on the server ([configure it](configure.md#5-leader-takeover)).

## A long transaction stays open

No event is delivered while an older transaction is still open, because that is what makes "no event is skipped" true. So one long write transaction,
anywhere in the database, stalls every view, automation and publisher until it ends. In the lab a 30 s transaction raised the lag to about 30 s, and it
was back under 2 s 0.2 s after the commit.

**Watch** idle-in-transaction sessions (`pg_stat_activity`), and set `idle_in_transaction_session_timeout` on the server.

## The database runs out of connections

Commands fail and nothing in the pods says why. In the lab, with `max_connections=20` against four pods of 10, about a fifth of the commands failed and
no pod restarted. Keep *instances × pool* under `max_connections` ([size the pool](run-in-production.md#size-the-pool)).

## Several instances apply the migrations at once

The examples' "apply to a fresh database" at start-up is not safe with several instances: in the lab, five pods starting together failed in different
ways on each run. Use a pre-deploy migration job; Flyway with its history lock passed three times out of three
([apply the migrations](run-in-production.md#1-apply-the-migrations)).

## A handler keeps failing

A projector, automation or publisher that fails is retried. After `maxErrors` failures in a row (10 by default) its processor is marked `FAILED` and
stops; the others carry on. Reads over a `FAILED` view answer `503` at once. See the [runbook](runbooks.md#a-processor-has-failed).

## A stored event cannot be read

An unsafe change to an event definition (a renamed, retyped or removed field) makes old events unreadable. A command whose boundary contains one fails
on every attempt with a `500`; a view or automation that reads one becomes `FAILED`. Nothing is skipped and nothing is misread. See the
[runbook](runbooks.md#stored-events-cannot-be-read).

## The views service is down

With roles split: if the `views` deployment is down, commands carry on, and strict reads wait 5 s and answer `503` with `Retry-After`. If the
`automations` or `outbox` deployment is down, follow-up commands and publications are late, not lost: they resume from their cursors.
