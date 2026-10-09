# ADR-0015: Read consistency is a property of the read, requested with a write marker

## Status

Accepted, and implemented (docs/plans/read-consistency.md, phases 0-6). Supersedes the `?waitFor=<view>` part of the command API (ADR-0011 and the tutorial's step 4). Breaking under ADR-0013: the removal landed in one commit that updated every consumer in this repository.

## Context

Views are updated by a background poller, so a client that has just written can read a view that does not include its write. Today the writer opts in on the command: `POST /api/commands/<name>?waitFor=<view>` holds the response until one view's cursor has passed the command's write (`WaitUntilProcessed.ts`, `CommandApiLive.ts`).

That puts a read concern on the write request, and it has three problems:

- **One view only.** A command whose events feed several views (a deposit updates a balance, a transaction list and a summary) cannot wait for all of them. The caller waits on the slowest one it knows of and hopes.
- **Only the writer can use it.** A second service, a second tab or a later request has the write's marker but nowhere to use it.
- **The command API needs to know about views.** `commands-http` takes a `viewWaiters` map from the app, so a package that should only run commands has a view-shaped option.

The command response already carries the write's position in the log as `lastTransactionId` and `lastPosition` (ADR-0012). That is everything a reader needs.

## Decision

1. **The command returns a marker and waits for nothing.** The response gains `marker`, the string `<transactionId>:<position>`, next to the existing fields. `?waitFor`, `?waitTimeout`, `ViewWaiter` and the `viewWaiters` option are removed. `commands-http` no longer mentions views.
2. **A read asks to be consistent with a marker.** `GET ...?consistentWith=<marker>`. The wrapper around a read handler waits until every view the endpoint reads has a cursor at or past the marker (or has no matching event pending between its cursor and the marker, as `waitUntilProcessed` already decides), then runs the handler. `consistentWith=latest` asks for the head of the log as of the request: the server reads the greatest committed `(transaction_id, position)` once (one indexed query), then waits for that marker as above. "Latest" means the committed head at the moment of the request: a transaction still open then is not covered, and its events may be missing from the response. With no `consistentWith` at all, the endpoint's `whenNoMarker` setting decides (decision 5).
3. **An endpoint declares the views it reads** as a list of view subscriptions, or as a function of the request's parameters when a filter selects different views. They are subscriptions, not names: `waitUntilProcessed` needs each view's event selection to decide that nothing relevant is still pending. The wait covers all of them concurrently under one shared deadline.
4. **Three modes decide what a timeout means.**

   | Mode | A view has not caught up in time |
   |---|---|
   | `strict` | Fail: one `503` `application/problem+json` whose `reason` is `lagging` (with `Retry-After`, the lagging views and how far each got) or `view_failed` (a view marked `FAILED` fails at once, with no `Retry-After`: retrying will not help until someone resets it). It is one problem with a `reason`, not two, because `HttpApi` rejects a second response on the same status once one carries headers (see the spike result below). |
   | `bounded` | Run the handler and add the header `Crablet-Consistency: stale` (declared on the success schema, so it is in the OpenAPI description). |
   | `eventual` | Do not wait. |

5. **The server owns the default; a request may only tighten it, unless the server allows loosening.** Configuration, at the API level and overridable per endpoint:

   ```ts
   readConsistency: { mode: "strict", whenNoMarker: "latest", timeout: "5 seconds", maxTimeout: "30 seconds", clientMayRelax: false }
   ```

   `whenNoMarker` is `"latest"` (a request with no `consistentWith` is treated as `consistentWith=latest`) or `"none"` (it does not wait). The default is `"latest"`, so a client that forgets the marker still gets a consistent read; this is what makes "always consistent" something the server enforces. A request with `consistency=eventual` skips it, where `clientMayRelax` allows.

   A request may send `?consistency=<mode>` and `?waitTimeout=<ms>`. They are resolved as request, then endpoint, then API default. A request can always ask for a stricter mode than the endpoint's, and a looser one only when `clientMayRelax` is true; a looser one the server does not allow is a `400` (not silently raised to the default, which would hide what the client asked for). `waitTimeout` must be a whole number of milliseconds from 1 to `maxTimeout`; anything else, a larger value included, is a `400`. A configured default timeout above `maxTimeout` is held to it.
6. **Validation comes before waiting.** A bad `limit`, `after`, filter, `consistency`, `waitTimeout` or marker answers `400` at once and never waits. A marker beyond the head of the log is a `400`: an impossible marker would otherwise make every reader wait the full timeout.
7. **Pagination.** The marker guarantees the first page. Later pages need not send it, because in normal operation a view's cursor only moves forward (`ProcessorManagementService.reset` does not rewind it). The exception is the manual rewind in ADR-0012's recovery procedure: while a view is being rebuilt, a page can come from a partly rebuilt table. Paginated reads should use keyset cursors, not `OFFSET`.

## Alternatives considered

- **Extend `?waitFor` to a list.** Waits for several views concurrently and keeps the shape. Rejected as the end state: the write request still carries a read concern, the writer must know every view, and nobody but the writer can use it. It remains the smallest change if this ADR is not accepted.
- **Putting the wrapper in `commands-http` or `views`.** `commands-http` should not learn about views (the point of this change), and `views` has no HTTP dependency today and should not gain one.
- **Notify instead of poll for the wait.** The wait keeps its 25 ms poll of `crablet_view_progress`. A shared per-instance listener would be a better source, but it belongs with the live-feed connection work, not this change.

## Consequences

- **The command path has no view logic.** A command can feed any number of views without the command, the executor or `commands-http` knowing.
- **A retried command has no marker (checked, not yet fixed).** An idempotent repeat appends nothing, so its response has `marker: null`, and a client whose first response was lost loses read-your-write. The repeat can come from two places, and neither exposes a position today:
  - `idempotentBy`: `append_events_if` evaluates the idempotency query as a boolean (`crablet_items_match_any`) and answers only `IDEMPOTENCY_VIOLATION`. Returning a marker needs a new migration that also returns the greatest `(transaction_id, position)` among the matching events (the latest one is a safe bound for "the earlier write is visible"), `Duplicate` carrying it, and the executor passing it through.
  - `noop` from `decide`: the compiled handler has the model load's cursor (the last settled event of the boundary, which is what justified the no-op) but the `NoOp` decision does not carry it. Adding it is a small change inside `commands`, with no SQL.
  Both are a follow-up to phase 1 (see the plan); until then the marker is `null` on a repeat and a client should read with `consistentWith=latest` after a retry.
- **"At least the write" is not one snapshot.** After the wait, each view reflects the write and possibly later changes, and the views advance in separate transactions. Two views in one response can be at slightly different points. A screen that needs one consistent picture across views needs a different design.
- **`latest` closes the "client sent no marker" gap, and brings the poller's stall to readers.** With `whenNoMarker: "latest"` every read waits for the head of the log, so a client cannot get an inconsistent read by omitting the marker. The cost is one head-of-log query per read, and a dependency on the poller's progress: pollers only read events whose transaction id is below the oldest open transaction (ADR-0012), so while any long transaction is open, a `latest` read cannot catch up and a `strict` one answers `503`. That is the stall operators already have to alarm on (see the scale envelope), now visible to every reader, and it is what "prefer consistency over availability" means here. `consistentWith=<marker>` is narrower and stalls less, because it waits only for the caller's own write; prefer it where the client has one.
- **A new package, `@crablet/views-http`.** It holds the read wrapper: marker parsing and validation, the policy resolution, the concurrent wait over view subscriptions, the `503` problem and the stale header. It depends on `views` (for `waitUntilProcessed` and `ViewSubscription`), `event-poller` and Effect's HTTP API. `commands-http` and `views` keep their current dependencies. The example apps' read endpoints are wrapped with it.
- **Reads cost more.** A read with a marker runs one head-of-log check once, then, per view, a progress query every 25 ms while it waits, plus a pending-events query on each tick while the view is behind. These count against the connection pool; budget them with the rest of the scale envelope. (Since 2026-10-09 the first look is one statement, not three: see "Update: the first look is one statement" at the end.)
- **Breaking change, one commit.** About 35 files mention `?waitFor`, `viewWaiters`, `ViewWaiter`, `ViewWaitResult` or `waitTimeout`, historical plans included (the plan lists them): `commands-http` (`CommandApi`, `CommandApiConfig`, `CommandApiLive`, `ViewWaiter`), both example apps, the course UI (which sends the marker on its next read where it used `waitForView`), the tests, the regenerated `docs/api/*.json`, tutorial step 4, the README, NOTES and the plans, and ADR-0011, which describes `?waitFor` and must be amended. All change together (ADR-0013).

## Open questions

- **How an endpoint declares the contract.** Today the reads are hand-written `HttpApi` groups in the example apps. Each read endpoint needs `consistentWith`, `consistency` and `waitTimeout` in its query, its success schema wrapped for the stale header, and the `400` and the `503` in its errors, so the generated OpenAPI documents them. `views-http` provides those pieces (a success wrapper, the query fragment, the problem) so an endpoint adds them in a line or two. What `HttpApi` supports is settled by the spike below.
- **`latest` under many readers.** Measured in phase 7 (below): the head-of-log query does not show up, so no cache of the head was built. The `Crablet-Consistency` response header on a typed success response is unverified against Effect's `HttpApi`; check it before relying on it.
- **The `Retry-After` value.** Settled in phase 3: 1 second, configurable where the wrapper is built (`retryAfterSeconds`). A view's polling interval is not known to the wrapper, and one second is what a client should wait before the views can plausibly have moved.
- **Offset pagination becomes a visible problem.** The wallet's transaction list (`page`/`size` with `OFFSET`, sorted by `occurred_at DESC`) shifts under concurrent writes and can repeat or skip a row. That is true today; this ADR does not fix it, but it recommends keyset `(occurred_at, id)` first.
- **Unchanged.** The SSE feed (ADR-0014) and its connection cost stay as they are. A client with no marker learns of changes by ping and re-reads without waiting.

## Spike result: what `HttpApi` supports (phase 2, Effect 4.0.0)

Checked with a throwaway server and client, then removed; phase 3 keeps the same checks as a permanent test of the helpers.

- **A success response with an optional header works, and is documented.** `HttpApiSchema.WithHeaders(Body, { "crablet-consistency": Schema.optionalKey(Schema.Literal("stale")) })` on the success schema; the handler returns `HttpApiSchema.withHeaders({ body, headers })`. An absent header is omitted from the response and a present one is sent. The generated OpenAPI lists the header under the `200` response (`required: false`).
- **A `503` problem with `Retry-After` works, and is documented.** The problem class piped through `HttpApiSchema.encodeToWithHeaders({ body, headers: { "retry-after": Schema.Int } }, { decode, encode })`; a handler fails with the plain problem value. The wire has status `503`, `application/problem+json` and `retry-after: 2`; OpenAPI lists `retry-after` under `503` (its schema is a loose numeric-string pattern).
- **One endpoint can declare several errors.** A domain `404`, the shared `400` (`BadRequestProblem`) and the `503` all appear in the description and answer with their own status.
- **Limit: a response with headers cannot share its status and content type with another response.** Declaring a second `503` `application/problem+json` beside the one with `Retry-After` fails when the endpoint is built (`Cannot combine a response with headers with another response for status 503`). Hence one `503` problem with a `reason` and an optional header: the header is omitted for `view_failed` and the OpenAPI marks it `required: false`. (Declaring the failed view under another status is the alternative; one problem with a `reason` was chosen because both cases mean "the read cannot be consistent right now".)
- **Cost: the derived client's success type changes.** For an endpoint whose success is wrapped with headers, `HttpApiClient` resolves to `{ body, headers }`, not the body. Every consumer of a wrapped read (the course page and the tests, in phase 5) reads `.body`, and can read the `Crablet-Consistency` header from `.headers`. Failures arrive as the decoded problem value.
- **Not chosen:** setting the header from the handler with `HttpEffect.appendPreResponseHandler` (what `HttpApiBuilder` uses internally). It would leave the success type unchanged, but the header would be missing from the OpenAPI description. Not tested here.

## Implementation notes (phase 3)

Decisions the implementation made that the text above leaves open:

- **Order of operations in a read.** Consistency parameters are validated, then the endpoint's own parameters (`parse`), then the head of the log is read once (also to reject a marker beyond it), then every view is waited for at the same time, then the handler runs or the read is refused or marked stale. `consistency=eventual` still validates every parameter but never touches the database. An endpoint declares `parse` separately from its handler for exactly this: validation runs before any waiting.
- **`bounded` with a failed view** is served stale like a lagging one (bounded is best effort); `strict` with a failed view is refused at once with `reason: "view_failed"`.
- **`reads` is a list of subscriptions or a function of the parsed parameters.** An endpoint that reads no views (or a function that returns none) never waits, but a marker is still checked against the head of the log.
- **A database failure while checking** (the head query, a view's progress) is a defect, a `500`, never a `503`: it is not a verdict about the views.
- **`503` bodies list every view that was behind**, each with its own reason and, for a lagging one, the position its progress had reached.
- **Metrics:** `crablet.read.consistency.reads` (tagged `mode` and `outcome`: `skipped`, `caught_up`, `stale`, `timeout`, `view_failed`) and `crablet.read.consistency.wait.duration`.
- **The example apps (phases 4 and 6).** Both apps' reads use the server default (strict, a read with no marker waits for the head of the log): a read made after a write includes it. The wallet does not let a client loosen a read. The course app does (`clientMayRelax`), because its tutorial and its page show the difference: `?consistency=eventual` answers at once and may be stale (the page's checkbox, unticked, asks for it), `bounded` answers marked stale after the timeout. Phase 4 had given the course app `whenNoMarker: "none"` as a transitional choice while its page learned to send markers; phase 6 moved it to the default.

## Measured costs (phase 7)

`examples/course-enrolment-app/scripts/bench-reads.ts` (one laptop, app, database and load generator together, a pool of 10, one view per read; numbers compare modes, they are not capacity figures; NOTES has the tables):

- **A consistent read costs about two more queries than one that does not wait**: the head of the log (or the marker check) and one progress query per view. On an idle log that is about half the throughput (`latest` and a marker are equal) and about half a millisecond more at p50 with the database on localhost; across a network it is about two extra round trips. Folding the head and progress queries into one statement would make it one round trip; not built.
- **The head-of-log query is not a cost**: 0.02-0.03 ms of execution on a log of 2,000,000 events (an index-only backward scan, 4 buffers). No cache of the head is needed.
- **A polling wait adds up to one poll interval, about 15 ms on average.** (First written as "a 25 ms floor"; corrected after ADR-0016 was measured.) A read that carries a write's marker, made right after the write with nothing else going on, took p50 30.7 ms with the 25 ms poll and 14.7 ms with the hub's ping: the remaining ~15 ms is the view applying the write itself, which no wait can shorten. Under about 25 writes/s a `latest` read had p95 37-50 ms polling against 7-14 ms for a read that does not wait; most of that gap is also the view's own latency, and the hub took it to 27-42 ms.
- **A polling reader costs about 68 queries/s while it waits**: measured directly, one waiter polling for 1.5 s made 102 queries against 8 with the hub (`wait-until-processed-hub.test.ts`). (First written as "up to about 80 queries/s", supported by the database's transaction counter in scenario 3; that counter included the unrelated probe reader's own ~1,200 reads/s and did not show it. The direct count does.) At scale it adds up: with connections warmed, 200 readers waiting at once made about 300 transactions/s polling and about 33 with the hub, and an unrelated read's p95 was 49 ms polling against 7 ms with the hub (ADR-0016 "Measured results").
- **A burst of simultaneous waiters is not slow in itself.** (An earlier version of this section reported a stretch of +200 ms at 50 waiters and +500-800 ms at 200 over the 400 ms lag, "not caused by polling", and unrelated reads staying fast. Both were wrong: the burst was opening N FRESH TCP connections in the one process that also runs the app, the view's own batch and the load generator, which took CPU from all three and delayed the view's batch with it; with the connections warmed, 200 waiters complete at the view's own time, about 475-505 ms for a 400 ms lag, polling or hub. The "unrelated reads stayed fast" came from a probe looping flat out whose thousands of reads fell outside the burst.)
- **Decision.** Keep the polling wait: it is simple and correct, and these numbers fit the scale envelope for a few hundred reads per second per instance. The replacement, when many readers wait at once or the 25 ms floor matters, is to wait on the progress ping that views already send after each commit (ADR-0014) through ONE `LISTEN` per instance and an in-process hub, checking the table only at the start and on a ping. That is the same shared listener that removes the one-connection-per-open-page limit of the live feed, so the two should be one piece of work. Until then `waitUntilProcessed`'s `interval` is the knob (a longer interval halves the polling load and raises the floor); the wrapper does not expose it yet.
  **Update (ADR-0016, measured).** The shared listener was built and measured (ADR-0016 "Measured results"): read-your-own-write p50 30.7 ms to 14.7 ms, about 3 times fewer queries from waiting readers, and live feeds that hold no connection each. The polling wait remains the fallback when no hub is provided or its LISTEN is down.

## Update: the first look is one statement (2026-10-09)

A default read sent four statements in a row to the database: the end of the log, the view's progress row, "is anything this view handles pending between its cursor and the end?", and the application's own query. The first three are the framework's and depend on one another (the pending check needs the other two as its bounds). They are now **one statement** (`readCheck`, `packages/views/src/ReadCheck.ts`, built by `buildReadCheckQuery` in `event-poller`), so a default read is two statements and a read with a marker is two (it was three). The application's query is still its own and still separate: the first look names only `crablet_events` and `crablet_view_progress`, and the view's query names no framework table (the integration test `read-statements.test.ts` counts the statements with `pg_stat_statements` and checks both).

What to do about each view is one pure function, `viewVerdict` (`caught_up`, `failed`, `wait`), shared with `waitUntilProcessed`; only the views whose verdict is `wait` go on to the waiting loop, which is unchanged (so it still subscribes to the hub's pings, and still looks again after subscribing). `makeConsistentRead` uses the combined look unless its `deps` are replaced without a `check` (the tests that fake `head` and `wait` keep their old path).

**Measured** (`examples/wallet-example-app/diagnostics/read-first-look.diagnostic.ts`: the real `makeConsistentRead`, before and after, with a network delay on the database's container; the wrapper and the application's query, not the HTTP stack; one run, reads alternated; p50, ms):

| added delay (`SELECT 1` p50) | default read, one view | read with a marker | default read, two views | 16 concurrent default reads, reads/s |
|---|---|---|---|---|
| none (0.36 ms) | 1.25 -> 0.73 | 0.58 -> 0.48 | 0.99 -> 0.65 | 5,065 -> 8,585 |
| 0.5 ms (1.00 ms) | 4.08 -> 2.16 | 3.00 -> 2.09 | 4.05 -> 2.16 | 3,752 -> 7,001 |
| 1 ms (1.53 ms) | 6.44 -> 3.41 | 4.94 -> 3.39 | 7.37 -> 3.89 | 2,693 -> 5,335 |
| 2 ms (2.95 ms) | 12.74 -> 6.59 | 8.96 -> 6.18 | 11.97 -> 6.19 | 1,458 -> 2,918 |

The saving is about two round trips for a default read, so it grows with the latency between the application and the database; for a read with a marker (three statements to two) it is about one. The database itself spends 0.05 to 0.13 ms per read, so this is latency and pool occupancy, not database load. These are figures from a laptop with a simulated delay, not from AWS.

**A plan trap, found by measuring on 100,000 events.** The first version of the statement used `EXISTS (...)` for the pending check. Inside one statement the cursor and the end of the log are not known when the plan is made, and Postgres planned a Seq Scan of `crablet_events` for it (8 ms, growing with the log), and ran it even for a view already at the end of the log, where the old code never asked. The statement now uses a lateral "next matching event" probe, gated by "the cursor is behind the write", with `ORDER BY transaction_id, position LIMIT 1`: it keeps the `(transaction_id, position)` index, takes 0.6 to 1.05 ms for the whole first look across eight selection shapes and three distances from the end (diagnostic E9g and its companion; `packages/event-poller/diagnostics/tag-selection.diagnostic.ts`), and does not run for a view that has caught up. The equivalence test (`read-check.test.ts`) uses small logs and would not have shown this; the 100,000-event measurement did.

**The same trap in the pending query the waiting loop runs, fixed (2026-10-09).** `buildPendingSelectionQuery` (behind `hasPendingSelectedEvents`, run on every turn of the wait while a view is behind) had no `ORDER BY`, so the planner did not walk the `(transaction_id, position)` index and stop at the first match. On the same 100,000-event log it took 4 to 8 ms for a typical view selection (event types plus the wallet keys) 5,000 to 50,000 events behind, 3 to 7 ms for one event type or no restriction, and 45 ms for a required key present on every event (a Seq Scan of `crablet_event_tag_keys` with one probe of the log per row). With `ORDER BY e.transaction_id, e.position LIMIT 1`: 0.4 to 0.6 ms in the same cases, and no case measurably worse, for both `tagKeys` strategies (measured over ten selection shapes and four distances; with `scan`, a key that never occurs is an inherent scan, 4 to 76 ms, the same before and after). A result cannot tell the two plans apart, so `pending-query-plan.test.ts` reads the plan on a 100,000-event log and fails on a Seq Scan of either table; it failed on four of four cases before the change. The diagnostic E9g timings above for the "three statements" were taken before this and show the old pending query.

**The metric moves.** `crablet.read.consistency.wait.duration` now covers the combined first look and any wait (it used to start after the end of the log was read), so its p95 on the dashboard drops when this is deployed. The drop is this change, not a faster database.

