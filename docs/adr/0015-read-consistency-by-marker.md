# ADR-0015: Read consistency is a property of the read, requested with a write marker

## Status

Proposed. Supersedes the `?waitFor=<view>` part of the command API (ADR-0011 and the tutorial's step 4). Breaking under ADR-0013: it lands in one commit that updates every consumer in this repository.

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
   | `strict` | Fail: `503` `application/problem+json`, `Retry-After`, the lagging views and how far each got. A view marked `FAILED` fails at once with a different problem type and no `Retry-After`. |
   | `bounded` | Run the handler and add the header `Crablet-Consistency: stale`. |
   | `eventual` | Do not wait. |

5. **The server owns the default; a request may only tighten it, unless the server allows loosening.** Configuration, at the API level and overridable per endpoint:

   ```ts
   readConsistency: { mode: "strict", whenNoMarker: "latest", timeout: "5 seconds", maxTimeout: "30 seconds", clientMayRelax: false }
   ```

   `whenNoMarker` is `"latest"` (a request with no `consistentWith` is treated as `consistentWith=latest`) or `"none"` (it does not wait). The default is `"latest"`, so a client that forgets the marker still gets a consistent read; this is what makes "always consistent" something the server enforces. A request with `consistency=eventual` skips it, where `clientMayRelax` allows.

   A request may send `?consistency=<mode>` and `?waitTimeout=<ms>`. They are resolved as request, then endpoint, then API default. A request can always ask for a stricter mode than the default, and a looser one only when `clientMayRelax` is true. The timeout is capped at `maxTimeout`.
6. **Validation comes before waiting.** A bad `limit`, `after`, filter, `consistency`, `waitTimeout` or marker answers `400` at once and never waits. A marker beyond the head of the log is a `400`: an impossible marker would otherwise make every reader wait the full timeout.
7. **Pagination.** The marker guarantees the first page. Later pages need not send it, because in normal operation a view's cursor only moves forward (`ProcessorManagementService.reset` does not rewind it). The exception is the manual rewind in ADR-0012's recovery procedure: while a view is being rebuilt, a page can come from a partly rebuilt table. Paginated reads should use keyset cursors, not `OFFSET`.

## Alternatives considered

- **Extend `?waitFor` to a list.** Waits for several views concurrently and keeps the shape. Rejected as the end state: the write request still carries a read concern, the writer must know every view, and nobody but the writer can use it. It remains the smallest change if this ADR is not accepted.
- **Putting the wrapper in `commands-http` or `views`.** `commands-http` should not learn about views (the point of this change), and `views` has no HTTP dependency today and should not gain one.
- **Notify instead of poll for the wait.** The wait keeps its 25 ms poll of `crablet_view_progress`. A shared per-instance listener would be a better source, but it belongs with the live-feed connection work, not this change.

## Consequences

- **The command path has no view logic.** A command can feed any number of views without the command, the executor or `commands-http` knowing.
- **A retried command has no marker.** An idempotent repeat appends nothing, so its response has `marker: null`. A client whose first response was lost then loses read-your-write. Open question: return the marker of the event that caused the duplicate. The idempotency check already finds it, so this is probably cheap; confirm before building.
- **"At least the write" is not one snapshot.** After the wait, each view reflects the write and possibly later changes, and the views advance in separate transactions. Two views in one response can be at slightly different points. A screen that needs one consistent picture across views needs a different design.
- **`latest` closes the "client sent no marker" gap, and brings the poller's stall to readers.** With `whenNoMarker: "latest"` every read waits for the head of the log, so a client cannot get an inconsistent read by omitting the marker. The cost is one head-of-log query per read, and a dependency on the poller's progress: pollers only read events whose transaction id is below the oldest open transaction (ADR-0012), so while any long transaction is open, a `latest` read cannot catch up and a `strict` one answers `503`. That is the stall operators already have to alarm on (see the scale envelope), now visible to every reader, and it is what "prefer consistency over availability" means here. `consistentWith=<marker>` is narrower and stalls less, because it waits only for the caller's own write; prefer it where the client has one.
- **A new package, `@crablet/views-http`.** It holds the read wrapper: marker parsing and validation, the policy resolution, the concurrent wait over view subscriptions, the `503` problem and the stale header. It depends on `views` (for `waitUntilProcessed` and `ViewSubscription`), `event-poller` and Effect's HTTP API. `commands-http` and `views` keep their current dependencies. The example apps' read endpoints are wrapped with it.
- **Reads cost more.** A read with a marker runs one head-of-log check once, then, per view, a progress query every 25 ms while it waits, plus a pending-events query on each tick while the view is behind. These count against the connection pool; budget them with the rest of the scale envelope.
- **Breaking change, one commit.** About 35 files mention `?waitFor`, `viewWaiters`, `ViewWaiter`, `ViewWaitResult` or `waitTimeout`, historical plans included (the plan lists them): `commands-http` (`CommandApi`, `CommandApiConfig`, `CommandApiLive`, `ViewWaiter`), both example apps, the course UI (which sends the marker on its next read where it used `waitForView`), the tests, the regenerated `docs/api/*.json`, tutorial step 4, the README, NOTES and the plans, and ADR-0011, which describes `?waitFor` and must be amended. All change together (ADR-0013).

## Open questions

- **How an endpoint declares the contract.** Today the reads are hand-written `HttpApi` groups in the example apps. Each read endpoint's schema would need `consistentWith`, `consistency` and `waitTimeout` in its query and the `503` in its errors, so the generated OpenAPI documents them. `views-http` should provide those schema fragments so an endpoint adds them in one line.
- **`latest` under many readers.** Every read runs the head-of-log query. It is indexed and cheap, but at the scale envelope's read rates it is worth a measurement, and a short in-process cache of the head (a few milliseconds) is an option if it shows up. The `Crablet-Consistency` response header on a typed success response is unverified against Effect's `HttpApi`; check it before relying on it.
- **`Retry-After`.** The value for a strict timeout is not decided.
- **Offset pagination becomes a visible problem.** The wallet's transaction list (`page`/`size` with `OFFSET`, sorted by `occurred_at DESC`) shifts under concurrent writes and can repeat or skip a row. That is true today; this ADR does not fix it, but it recommends keyset `(occurred_at, id)` first.
- **Unchanged.** The SSE feed (ADR-0014) and its connection cost stay as they are. A client with no marker learns of changes by ping and re-reads without waiting.
