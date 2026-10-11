# Runbooks

*Guide · whoever is on call · [failure modes](failure-modes.md) read · one section per alert*

One section per alert in [`ops/grafana/alerts.yaml`](../../../ops/grafana/alerts.yaml), in the order a person on call needs: what it means, what to
check, what to do. The processor actions (pause, resume, reset) are in the admin API ([`@crablet/processors-http`](../../../packages/processors-http/README.md))
and its page ([`tools/processors-admin-ui`](../../../tools/processors-admin-ui/README.md)).

## A processor has FAILED

**Means:** a view, automation or outbox publisher failed `maxErrors` times in a row and stopped. Other processors carry on. Reads over a failed view
answer `503` with reason `view_failed`.

**Check:**
1. The processor's last error: `GET /admin/processors` shows it, and so does `crablet_view_progress.last_error` (or the automation or outbox table).
2. If the error is an `EventDecodingError`, go to [stored events cannot be read](#stored-events-cannot-be-read).
3. Otherwise it is the handler or what it calls: a bug, a missing table or column, an external system that is down (for an outbox publisher).

**Do:** fix the cause and deploy, then **reset** the processor. Reset clears the error count, sets it `ACTIVE` and resumes it from where it stopped;
it does not rewind the cursor, so nothing is handled twice by the reset itself.

## A module has no leader

**Means:** nothing is running the views, the automations or the outbox, or nothing is reporting leadership at all. A crashed leader is recognised after
two minutes of silence.

**Check:**
1. Are the instances that run this module up (`GET /status` on each shows whether it runs the module and leads it)?
2. Can they reach Postgres? A silent partition holds the lock until the server's keepalives give up ([failure modes](failure-modes.md#a-leader-loses-the-network)).
3. Are the connections exhausted? A process with no free connection cannot take the lock.

**Do:** start an instance that runs the module, or restore its network. If the old leader's session is stuck, terminating it on the server
(`pg_terminate_backend`) frees the lock, and a follower takes over at its next retry.

## A consumer is behind

**Means:** a processor has had events waiting for more than five minutes. It is `ACTIVE`, but slow or stuck.

**Check:**
1. A long-running or idle-in-transaction session in `pg_stat_activity`. No event is delivered while an older transaction is open ([failure modes](failure-modes.md#a-long-transaction-stays-open)).
2. Handler failures (the next alert): a processor retrying a failing batch does not advance.
3. The handler's duration (`crablet.view.project.duration` and its peers) against the rate of new events: a handler slower than the writers falls behind for good.

**Do:** end the long transaction; fix a failing handler; for a slow one, make the projector cheaper or raise `batchSize`. If the consumer may
legitimately lag (a nightly export), raise the alert's threshold for it.

## Handlers are failing

**Means:** projections, automations or publishers failed in the last five minutes. They retry; after `maxErrors` in a row a processor becomes `FAILED`.

**Check:** the dashboard's failure panels say which; the processor's last error says why.

**Do:** as for [a processor that has failed](#a-processor-has-failed), before it gets there. Pausing the processor stops the retries while you fix the
cause; resume it afterwards.

## Stored events cannot be read

**Means:** a stored event no longer fits its current definition: a field was renamed, retyped or removed, or its meaning changed. Commands whose boundary
contains it fail on every attempt, and processors that read it become `FAILED`. The event is never skipped.

**Check:** the log line and `crablet.eventstore.decoding_failures` name the event type and position. Compare the definition in the deployed code with the
previous release.

**Do:** revert or loosen the definition (a default, or an optional field) and deploy; then reset the failed processors. Never edit the stored event. To
correct facts, append a new event. Before the next deploy that changes an event, run `verify-events` against a copy of production
([Evolving events](../build/evolving-events.md)).

## Events cost more storage than expected

**Means:** the bytes per event (the events and the tag table, with their indexes) are above the threshold, 3,000 against about 1,200 when it was set.

**Check:** `storageReport()` (`examples/wallet-example-app/scripts/report-storage.ts` prints it): which table grew, and whether new events carry more
tags or larger payloads.

**Do:** nothing deletes events, so plan the growth: fewer or shorter tags, smaller payloads for new events, more disk. Retention is not decided
([events over time](../../concepts/events-over-time.md#growth)).
