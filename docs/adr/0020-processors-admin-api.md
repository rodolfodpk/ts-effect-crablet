# ADR-0020: The processors admin API is a description plus handlers, closed until the application says who may call it

## Status

Accepted (2026-10-08). Built as `@crablet/processors-http`, with a generic Foldkit page over it as an example.

## Context

A dashboard shows what the processors are doing ([dashboard plan](../plans/dashboard.md)); it cannot act. An operator who sees a `FAILED` view, a consumer that is stuck, or an outbox publisher to a broker that is down needs to pause, resume or reset it
without a shell on the host. The poller already has the operations (`ProcessorManagementService`: pause, resume, reset, status, backlog); what was missing was a way to reach them over HTTP, and three questions had to be answered before publishing it, because an external client typed against
the API makes each of them expensive to change.

## Decision

1. **A package of its own, a description and handlers.** `@crablet/processors-http` exports an `HttpApiGroup` (`processorsGroup`: `GET /admin/processors`, `POST /admin/processors/:kind/:id/pause|resume|reset`) and its handlers over a list of **sources** (`{ kind, service, describe? }`, one per module: views, automations, outbox, or anything with a `ProcessorManagementService`). A client is derived from the description (`HttpApiClient.make`) and is typed by it, as the course page is typed by the course API.
2. **Authorization is required, not optional.** Every endpoint carries `ProcessorsAuthorization`, an `HttpApiMiddleware` with a bearer security scheme (it appears in the OpenAPI description). The package ships no implementation by default: an application that mounts the group must provide one (`authorizationFrom(check)` is the convenience), or **the server does not start** (`Service not found: ...ProcessorsAuthorization`; through a web handler the first request is refused for the same reason). The layer's *type* does not show the requirement (checked: the layer is `Layer<never, never, HttpRouter>`), so this is a start-up failure, not a compile error, and the test says so. A check that fails is a 401; one that dies is a 500; neither lets the request through. The wallet example mounts the API only when `WALLET_ADMIN_TOKEN` is set.
3. **What each operation means, and says.** `pause` and `resume` set the status. `reset` **clears the error count, sets the status to `ACTIVE` and resumes; it does not move the cursor**. It is how a `FAILED` processor is restarted; it does not replay or skip events. An unknown kind or id is a 404 problem that says which. There is no operation that rewinds a cursor.
4. **Evolution rules.** The response gains fields, never loses or retypes one, and a client ignores fields it does not know. A new endpoint or a new optional parameter is fine; changing what an existing endpoint does gets a new path. `kind` and `id` are whatever the application named them, so nothing enumerates them. (This is the rule [`api-follow-ups.md`](../plans/api-follow-ups.md) item B left open for the command API's projection; it is decided here for this API because an external client exists by design. It is not yet enforced by a test that compares the description with a committed copy.)
5. **No leader in the list.** The progress tables record which instance *registered* a view or an automation, not which leads it, and only the outbox records a leader. A column that means different things per kind would mislead, so leadership stays where it is accurate: the `crablet.poller.leadership` metric and the dashboard.

## Consequences

- An application gets a working admin API in a few lines and cannot get an open one by omission; it can still get an open one on purpose (`authorizationFrom(() => Effect.succeed(true))`), which the README says is not for a reachable port.
- The list reads the module's progress tables for the failure details (`ProcessorManagementService.getAllDetails`) and the backlog counted against each processor's own selection ([dashboard plan, step 1](../plans/dashboard.md)); it is one query per processor, so it is for a page a person opens, not for a scraper (that is what the metrics are for).
- The API is a second public contract to keep stable (decision 4).
- Because the service is the same for every kind, an adopter's own processors appear with no code beyond naming a source.
