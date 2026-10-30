# Runbooks

*Guide · whoever is on call · [failure modes](failure-modes.md) read · one section per alert*

One section per alert in [`ops/grafana/alerts.yaml`](../../../ops/grafana/alerts.yaml), in the order a person on call needs: what it means, what to
check, what to do. The processor actions (pause, resume, reset) are in the admin API ([`@crablet/processors-http`](../../../packages/processors-http/README.md))
and its page ([`tools/processors-admin-ui`](../../../tools/processors-admin-ui/README.md)).

## A processor has FAILED

**Means:** a view, automation, outbox publisher or the deadlines processor failed `maxErrors` times in a row and stopped. Other processors carry on. Reads over a failed view
answer `503` with reason `view_failed`.

**Check:**
1. The processor's last error: `GET /admin/processors` shows it, and so does `crablet_view_progress.last_error` (or the automation or outbox table).
2. If the error is an `EventDecodingError`, go to [stored events cannot be read](#stored-events-cannot-be-read).
3. Otherwise it is the handler or what it calls: a bug, a missing table or column, an external system that is down (for an outbox publisher). An outbox
   error that says `took longer than ... ms` is the publish timeout (`publishTimeoutMs`, default 30 s): the destination is slow or hanging.
4. An automation whose error is `IdempotencyMismatch`: its `idempotentBy` matches another trigger's different request, so the key is too broad
   ([ADR-0034](../../adr/0034-a-repeat-must-be-the-same-request.md)). Fix the key in the code; the trigger has not been handled.
5. **The deadlines processor:** its last error is in `crablet_deadline_progress.last_error`. The causes are those of [a deadline's fault](../build/set-a-deadline.md):
   the command failed with something other than a domain error (the database, a conflict that ran out of retries), it took longer than `fireTimeoutMs`
   (30 seconds by default), the processor was not given that command, or the deadline's input no longer decodes. `GET /admin/processors` lists it only if
   the application gives the admin API a source made with `makeDeadlinesManagementService`, which none of the examples does; otherwise read the table.
   Its reset is the same: it clears the error and the due deadlines fire again in due order. There is no cursor to rewind: what is left to fire is
   the rows of `crablet_deadlines`.

**Do:** fix the cause and deploy, then **reset** the processor. Reset clears the error count, sets it `ACTIVE` and resumes it from where it stopped;
it does not rewind the cursor, so nothing is handled twice by the reset itself. An event is never skipped to get past a failure: order and no gaps come
first ([ADR-0036](../../adr/0036-outbox-delivery-event-id-timeout-and-partial-progress.md)). An outbox publisher that sends one event at a time and failed
part-way already kept the events it sent: it resumes at the first one that failed.

## A module has no leader

**Means:** for the views, the automations, the outbox or the deadlines, no instance has reported leading it for two minutes, so nothing is running that module's processors. Or, if the alert
says "no leadership data at all", nothing is reporting. Why two minutes: leadership is a gauge that is re-sent while it holds. A leader that crashes never reports "not leading", so
the alert waits until its last report is older than 120 seconds.

**Check, in this order:**

1. **Ask the instances.** Every process of the wallet serves `GET /status` on its port (8080 by default); an application of your own exposes its own. It says what the process runs and
   whether it leads each module right now:
   ```json
   {"pod":"wallet-views-1","roles":["views","automations"],"uptimeSeconds":812,
    "modules":[{"module":"views","runs":true,"leading":false},{"module":"automations","runs":true,"leading":true}]}
   ```
   (An example.) If no instance has `runs: true` for the module, nothing is started for it: start one. If some do and none leads, go on.
2. **Ask Postgres who holds the lock.** There is one advisory lock per module: views `4856221667890123457`, automations `4856221667890123458`, outbox `4856221667890123456`, deadlines `4856221667890123459`.
   ```sql
   SELECT a.pid, a.application_name, a.state, a.backend_start,
          ((l.classid::bigint << 32) | l.objid::bigint) AS lock_key
     FROM pg_locks l JOIN pg_stat_activity a USING (pid)
    WHERE l.locktype = 'advisory' AND l.granted;
   ```
   - **No row for the module's key:** nobody holds it. The followers take it at their next try (every 5 seconds by default, `leaderElectionRetryIntervalMs`), so within a few seconds the
     alert recovers on its own. If it does not, the instances cannot reach Postgres or have no free connection: check the next two points.
   - **A row, and no instance says it leads:** a session holds the lock that no process owns any more (a partition that Postgres has not yet given up on, or a stuck connection).
     `application_name` tells you which instance it was, if your application sets it (the wallet sets `wallet-<pod>`).
3. **Can the instances reach Postgres?** After a silent partition the server ends the silent leader's lock session after its `serverIdleTimeout` (15 seconds by default), and a follower
   takes the lock at its next try ([failure modes](failure-modes.md#a-leader-loses-the-network)). Waiting is correct in that case.
4. **Are the connections exhausted?** A process with no free connection cannot take the lock ([size the pool](run-in-production.md#size-the-pool)).

**Do:**
- Start an instance that runs the module, or restore the network.
- If a session you identified in step 2 holds the lock and its process is gone or unreachable, end it: `SELECT pg_terminate_backend(<pid>)`. The lock is freed at once and a follower takes
  it at its next try. Do not terminate the session of a process that says it is leading.
- **How long recovery takes:** after a graceful stop or a killed pod, under a second in the kind lab; after a crash, within the retry interval (5 seconds by default); after a silent
  partition, about the server idle timeout plus the retry interval (about 20 seconds by default). The alert clears once a leader has reported again.

## A consumer is behind

**Means:** a processor has had events waiting for more than five minutes. It is `ACTIVE`, but slow or stuck.

**Check:**
1. A long-running or idle-in-transaction session in `pg_stat_activity`. No event is delivered while an older transaction is open ([failure modes](failure-modes.md#a-long-transaction-stays-open)).
2. Handler failures (the next alert): a processor retrying a failing batch does not advance.
3. The handler's duration (`crablet.view.project.duration` and its peers) against the rate of new events: a handler slower than the writers falls behind for good.
4. **For the deadlines processor,** behind means deadlines that are due and not fired: its lag gauges count them, read from `crablet_deadlines`, and its management
   service reports them as the backlog (`pendingEvents`, `oldestPendingSeconds`). A command that is slow to run, or that keeps failing, holds the ones after it.

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
