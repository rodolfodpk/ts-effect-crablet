# @crablet/processors-http

An admin API over the background processors (views, automations, outbox publishers): list them with their status, failures, cursor and backlog, and pause, resume or reset one. The description is a plain
`HttpApiGroup`, so a client can be derived from it and typed by it. **It is closed until you say who may call it** ([ADR-0020](../../docs/adr/0020-processors-admin-api.md)).

## What it gives you

- **`processorsGroup`** (the package entry point) - `GET /admin/processors`, `POST /admin/processors/:kind/:id/pause`, `.../resume`, `.../reset`. Problems are RFC 7807 (`application/problem+json`).
- **`makeProcessorsApiGroupLive(api, sources)`** (`/ProcessorsApiLive`) - the handlers, over a list of `{ kind, service, describe? }` sources; `service` is a module's management service (`makeViewManagementService(handle)` and its siblings), `kind` is the word a client sees. `listProcessors` and `actOnProcessor` are exported for tests.
- **`ProcessorsAuthorization`**, **`authorizationFrom(check)`** (`/Authorization`) - the bearer-token middleware every endpoint carries, and a way to build its implementation from a check on the token.

```ts
const adminApi = HttpApi.make("admin").add(processorsGroup);
const layer = HttpApiBuilder.layer(adminApi).pipe(
  Layer.provide(makeProcessorsApiGroupLive(adminApi, sources)),
  Layer.provide(authorizationFrom((token) => isAdmin(Redacted.value(token))))   // yours: a static token, a JWT check, an identity service
);
```

The wallet example does this in [`WalletApp.ts`](../../examples/wallet-example-app/src/WalletApp.ts) (`makeWalletAdminApiLayer`), only when `WALLET_ADMIN_TOKEN` is set.

## Security

There is no default. Without an authorization layer the server **does not start** (`Service not found: ...ProcessorsAuthorization`). Pause stops a processor and reset restarts a `FAILED` one, so do not
serve this on a port you would not hand to an operator. `reset` clears the error count, sets the status to `ACTIVE` and resumes; it does not move the cursor.

## Depends on

[`@crablet/event-poller`](../event-poller/README.md) (`ProcessorManagementService`), `effect`.

## Read more

[ADR-0020](../../docs/adr/0020-processors-admin-api.md), [See it on a dashboard](../../docs/guides/dashboard.md), [Monitor it](../../docs/guides/monitor-it.md#inspect-and-control-processors).

Unit tests: `bun test packages/processors-http/test/*.test.ts` (no database: a fake management service, served through a web handler). The API over the wallet's real processors:
`node --test examples/wallet-example-app/test/integration/admin-api-e2e.test.ts` (Docker).
