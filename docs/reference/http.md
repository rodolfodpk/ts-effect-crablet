# HTTP

*Reference · developers exposing an API · [Expose a command over HTTP](../guides/build/expose-a-command-over-http.md) · look up*

The endpoints the packages give you, the statuses they answer with, and the read-consistency options. Why the API comes from the domain model:
[ADR-0011](../adr/0011-http-api-from-the-domain-model.md).

## Endpoints

| Endpoint | From | What it does |
|---|---|---|
| `POST /api/commands/<name>` | `@crablet/commands-http` | Runs one command. One route per command contract you list. |
| `GET /openapi.json` | `@crablet/commands-http` | The generated OpenAPI 3.1 description: every command's input, and every failure as `application/problem+json`. |
| your read endpoints | `@crablet/views-http` (`makeConsistentRead`) | Any `GET` you write over a view, made to honour a marker. |
| `GET /admin/processors` | `@crablet/processors-http` | Every processor: status, failures, cursor and backlog. Closed until the application provides an authorization ([ADR-0020](../adr/0020-processors-admin-api.md)). |
| `POST /admin/processors/:kind/:id/pause`, `.../resume`, `.../reset` | `@crablet/processors-http` | Pause, resume or reset one processor. |

A live-update feed of view pings (server-sent events) is declared by the application from `@crablet/views` (`ViewProgressFeed`); the course app serves
it at `GET /api/views/changes` ([reading your own writes](../concepts/read-your-writes.md#clients-that-did-not-write)).

The checked-in descriptions of the two examples: [`wallet-openapi.json`](../api/wallet-openapi.json), [`course-enrolment-openapi.json`](../api/course-enrolment-openapi.json).

## Command answers

| Status | When | Body |
|---|---|---|
| `201` | the command appended events | the result, with a `marker` |
| `200` | an idempotent repeat, or `noop` | the result; nothing appended. Its `marker` points at the earlier write (null only when there is nothing to point at) |
| `400` | the input does not match the schema, or a domain error of kind `invalid` | a problem: every failing field, or the error's fields |
| `403` | a domain error of kind `forbidden` | a problem with the error's fields |
| `404` | a domain error of kind `not_found` | a problem with the error's fields |
| `409` | a domain error of kind `conflict`; a `Conflict` after the retries ran out | a problem; a DCB conflict has its own shape, with `violationCode` `DCB_VIOLATION` or `GUARD_VIOLATION` |
| `422` | the request's id (`idempotentBy`) was already used by a different request | a problem with `violationCode` `IDEMPOTENCY_MISMATCH`; the earlier request stands. Send a new id for a new request ([ADR-0034](../adr/0034-a-repeat-must-be-the-same-request.md)) |
| `500` | anything unexpected, including a stored event that cannot be read | a generic problem; the message is not echoed |

Every problem is `application/problem+json` (RFC 7807) and documented per command in the OpenAPI description.

## Read consistency

A read made with `makeConsistentRead` accepts three query parameters.

| Parameter | Values | What it does |
|---|---|---|
| `consistentWith` | a marker (`<transactionId>:<position>`), or `latest` | Wait until the endpoint's views include that write, or everything committed when the request arrived. |
| `consistency` | `strict`, `bounded`, `eventual` | Ask for a mode. A stricter one than the endpoint's is always allowed; a looser one only with `clientMayRelax`. |
| `waitTimeout` | milliseconds, 1 to `maxTimeoutMs` | How long to wait. |

The server's settings (`ReadConsistencyConfig`, `@crablet/views-http/ReadConsistency`), for the whole API or per endpoint:

| Setting | Default | What it does |
|---|---|---|
| `mode` | `"strict"` | What a timeout means: `strict` answers `503`; `bounded` answers with the header `Crablet-Consistency: stale`; `eventual` does not wait. |
| `whenNoMarker` | `"latest"` | A read with no `consistentWith`: `latest` waits for the head of the log, `none` does not wait. |
| `timeoutMs` | `5000` | How long to wait. |
| `maxTimeoutMs` | `30000` | The most a request may ask for. |
| `clientMayRelax` | `false` | Whether a request may choose a looser mode than the endpoint's. |

| Read status | When |
|---|---|
| `400` | a bad marker, a marker beyond the end of the log, a bad `consistency` or `waitTimeout`; answered at once, without waiting |
| `503`, reason `lagging` | a view did not catch up in time; with `Retry-After` and how far each view got |
| `503`, reason `view_failed` | a view is `FAILED`; no `Retry-After`, because retrying will not help until it is reset |
