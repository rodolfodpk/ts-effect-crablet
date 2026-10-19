# @crablet/commands-http

A REST API over your commands. List the commands' **contracts** and you get `POST /api/commands/<name>` for each, validated against the input Schema, with every
domain error mapped to a status code and documented in a generated OpenAPI 3.1 description. Failures are RFC 7807 `application/problem+json`.

## What it gives you

- **`makeCommandApiGroup`** and **`makeCommandApi`** (`/CommandApi`) - declare the API from contracts alone, so a browser can import it without receiving any `decide`.
- **`makeCommandApiGroupLive`** and **`makeCommandApiLive`** (`/CommandApiLive`) - the server side: pass the commands built from each contract. A missing or extra one does not compile, and a command that does not declare `idempotentBy` is refused when the layer is built: a client retries a request whose answer it lost ([ADR-0034](../../docs/adr/0034-a-repeat-must-be-the-same-request.md)).
- **`ProblemDetail`** - the problem bodies (bad request with the failing fields, conflict, a request id reused by a different request (422), unexpected error). A command also answers with a **marker** for read-your-writes, a repeat included.
- **`ApiDescription`**, **`InputJsonSchema`** - the generated OpenAPI description.
- **`Cors`** - opt-in CORS.

## Depends on

[`@crablet/commands`](../commands/README.md), [`@crablet/eventstore`](../eventstore/README.md), `effect`.

## Read more

[Tutorial step 3](../../docs/tutorial/03-an-http-api.md), [ADR-0011](../../docs/adr/0011-http-api-from-the-domain-model.md), and the generated descriptions in
[`docs/api/`](../../docs/api). Reads that wait for a write are in [`@crablet/views-http`](../views-http/README.md).

Unit tests: `bun test packages/commands-http/test/*.test.ts`. Integration tests (real Postgres through Testcontainers, needs Docker): `node --test "packages/commands-http/test/integration/*.test.ts"`.
