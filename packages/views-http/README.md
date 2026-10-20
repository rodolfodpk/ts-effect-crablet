# @crablet/views-http

Consistent reads over views. A read that carries a command's **marker** (`?consistentWith=<marker>`) is answered only once the views it uses have processed that
write; with no marker it waits for everything committed. The default is strict: the answer is right or a `503`, never stale.

## What it gives you

- **`makeConsistentRead`** (`/ReadConsistency`, `/ReadQuery`) - wrap a read handler so it honours the marker, with a policy (strict, or bounded and marked stale).
  The waiting itself is `settleViews` from [`@crablet/views`](../views/README.md): one statement for where the log ends and where each view is, then a wait for only the views still behind ([ADR-0015](../../docs/adr/0015-read-consistency-by-marker.md)).
- Write a read group against the API's own type (`HttpApiBuilder.group(api, "courseQueries", ...)` with `api: CourseApi`), not generic over any API: `consistentRead`'s `parse` and handler are then typed from the endpoint, with nothing annotated.
- **`ReadProblems`** - the `503` (`ViewsUnavailable`) and the other problem bodies, as schema fragments to add to your endpoints.

## Depends on

[`@crablet/commands-http`](../commands-http/README.md), [`@crablet/views`](../views/README.md), [`@crablet/event-poller`](../event-poller/README.md),
[`@crablet/eventstore`](../eventstore/README.md), `@crablet/metrics-otel`.

## Read more

[Tutorial step 4](../../docs/tutorial/04-read-your-own-writes.md), [ADR-0015](../../docs/adr/0015-read-consistency-by-marker.md). Used by the wallet's and the course app's reads.

Unit tests: `bun test packages/views-http/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/views-http/test/integration/*.test.ts"`.
