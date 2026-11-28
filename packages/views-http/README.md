# @crablet/views-http

Consistent reads over views. A read that carries a command's **marker** (`?consistentWith=<marker>`) is answered only once the views it uses have processed that
write; with no marker it waits for everything committed. The default is strict: the answer is right or a `503`, never stale.

## What it gives you

A consistent read comes from two imports, split as the live feed's are: what the endpoint declares, safe for the browser, and the server side. The package
root (`@crablet/views-http`) is the declarations of both, `/ReadsApi` and `/LiveFeedApi` together; the server sides stay their own imports.

- **`consistencyQuery`**, **`ReadSuccess`**, **`readProblems`** (`/ReadsApi`, browser-safe) - what a read endpoint declares: the three consistency parameters, the success with the
  optional stale header, and the `400` and `503` (`ViewsUnavailable`) it can answer, which a client also checks.
- **`makeConsistentRead`** (`/ReadsLive`) - the wrapper a read handler goes through, so it honours the marker, with a policy (strict, or bounded and marked stale;
  `ReadConsistencyConfig`, `defaultReadConsistency`). It is an `Effect`, run where the group is built
  (`HttpApiBuilder.group(api, name, (handlers) => Effect.map(makeConsistentRead({ config }), (read) => handlers.handle(...)))`): it takes the database and
  the `ViewProgressHub` there, so an API whose reads have no hub does not compile. Provide `ViewProgressHubLive` (one LISTEN for the process, shared
  with the live feed) or `viewProgressPolling()` to the API layer. `makeConsistentReadWith(settle)` is the same wrapper over another `settle`, for tests.
  The waiting itself is `settleViews` from [`@crablet/views`](../views/README.md): one statement for where the log ends and where each view is, then a wait for only the views still behind ([ADR-0015](../../docs/adr/0015-read-consistency-by-marker.md)).
- Write a read group against the API's own type (`HttpApiBuilder.group(api, "courseQueries", ...)` with `api: CourseApi`), not generic over any API: `consistentRead`'s `parse` and handler are then typed from the endpoint, with nothing annotated.
- **`liveFeedGroup(name)`** (`/LiveFeedApi`, browser-safe) and **`liveFeedHandler({ views, maxLifetime })`** (`/LiveFeedLive`) - the live feed,
  `GET /api/views/changes?views=a,b`: server-sent "this view moved" pings, a hint for a page to read again ([ADR-0016](../../docs/adr/0016-one-listen-per-process-for-view-progress.md)).
  Add the group to your API under your name, and register the handler in one line (the course does it in `src/api/CourseFeedApiLive.ts`); an unknown
  view name is a `400`, and each connection ends after `maxLifetime` (default 5 minutes) so no proxy holds it for ever.

## Depends on

[`@crablet/commands-http`](../commands-http/README.md), [`@crablet/views`](../views/README.md), [`@crablet/event-poller`](../event-poller/README.md),
[`@crablet/eventstore`](../eventstore/README.md), `@crablet/metrics-otel`.

## Read more

[Tutorial step 4](../../docs/tutorial/04-read-your-own-writes.md), [ADR-0015](../../docs/adr/0015-read-consistency-by-marker.md). Used by the wallet's and the course app's reads.

Unit tests: `bun test packages/views-http/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/views-http/test/integration/*.test.ts"`.
