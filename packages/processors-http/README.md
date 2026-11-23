# @crablet/processors-http

An admin API over the background processors (views, automations, outbox publishers), and over the event log: list the processors with their status, failures, cursor and
backlog, and pause, resume or reset one; browse the events page by page, with personal data masked. The description is one
`HttpApi`, `adminApi`, which the server mounts and a client is derived from, both typed by it. **It is closed until you say who may call it** ([ADR-0020](../../docs/adr/0020-processors-admin-api.md)).

## What it gives you

- **`processorsGroup`** (the package entry point) - `GET /admin/processors`, `POST /admin/processors/:kind/:id/pause`, `.../resume`, `.../reset`. Problems are RFC 7807 (`application/problem+json`).
- **`adminApi`** (`/AdminApi`) - the two groups below as one API: what a server mounts and what a client (`HttpApiClient.make(adminApi)`) is derived from. It imports nothing of the server.
- **`adminApiLayer({ masks })`** (`/AdminApiLive`) - the API served, every handler checked against its endpoint (no cast: the API is concrete). It reads the modules from the `Processors` service (`@crablet/modules/Processors`, which `Crablet.processors` or `Crablet.catalog` of `@crablet/app` provides) and needs the `EventStore`, and its type requires `ProcessorsAuthorization`: a server without one does not compile.
- **`processorsHandlers(sources)`** (`/ProcessorsApiLive`) - the handlers, over a list of `{ kind, service, describe? }` sources (`ProcessorSource`, from `@crablet/modules`); `service` is a module's management service (`makeViewManagementService(handle)` and its siblings), `kind` is the word a client sees. `listProcessors` and `actOnProcessor` are exported for tests.
- **`eventsGroup`** (`/EventsApi`) - `GET /admin/events?types=A,B&tag=key=value&after=<cursor>&limit=100`: one page of the log in order, of events whose transaction
  had finished, with the `cursor` to read on from ([ADR-0050](../../docs/adr/0050-the-event-store-used-directly.md)). Any of the types, all of the tags; neither, every event.
- **`eventsHandler({ mask })`** (`/EventsApiLive`) - its handler, over the `EventStore`. `mask` decides what of a payload is shown: build it with
  `eventPayloadMask(definitions)` from `@crablet/commands/Personal`, which redacts the fields marked `personal(...)` and drops the keys a definition does not know (an older
  field could hold personal data no mark covers). A type with no definition shows no payload, and without a mask no payload is shown at all. An event's metadata ([ADR-0051](../../docs/adr/0051-client-metadata-correlation-and-causation.md)) is
  shown only through a `metadataMask` the application gives (it has no schema to mark personal data with); without one it is withheld. `listEvents` is exported for tests.
- **`ProcessorsAuthorization`**, **`authorizationFrom(check)`** (`/Authorization`) - the bearer-token middleware every endpoint carries, and a way to build its implementation from a check on the token.

```ts
const layer = adminApiLayer({ masks: { mask: eventPayloadMask(myEventDefinitions) } }).pipe(   // needs Processors and the EventStore
  Layer.provide(authorizationFrom((token) => isAdmin(Redacted.value(token))))   // yours: a static token, a JWT check, an identity service
);
```

To put the groups in an API of your own instead (one OpenAPI document with your routes), register `processorsHandlers(sources)` and `eventsHandler(masks)` in your
`HttpApiBuilder.group(yourApi, "processors" | "events", ...)`: your API is concrete, so they are typed there too.

The wallet example does this in [`WalletApp.ts`](../../examples/wallet-example-app/src/WalletApp.ts) (`makeWalletAdminApiLayer`), only when `WALLET_ADMIN_TOKEN` is set.

## Security

There is no default. Without an authorization layer the server **does not compile** (the layer requires `ProcessorsAuthorization`), and code that gets past the compiler **does not start** (`Service not found: ...ProcessorsAuthorization`). Pause stops a processor and reset restarts a `FAILED` one, so do not
serve this on a port you would not hand to an operator. `reset` clears the error count, sets the status to `ACTIVE` and resumes; it does not move the cursor. The event log
shows payloads only through the application's mask: whoever holds the token sees the events, never a field marked personal.

## Depends on

[`@crablet/event-poller`](../event-poller/README.md) (`ProcessorManagementService`), [`@crablet/eventstore`](../eventstore/README.md) (the event log's `read`), `effect`.

## Read more

[ADR-0020](../../docs/adr/0020-processors-admin-api.md), [See it on a dashboard](../../docs/guides/operate/dashboard.md), [Monitor it](../../docs/guides/operate/monitor-it.md#inspect-and-control-processors).

Unit tests: `bun test packages/processors-http/test/*.test.ts` (no database: a fake management service, served through a web handler). The API over the wallet's real processors:
`node --test examples/wallet-example-app/test/integration/admin-api-e2e.test.ts` (Docker).
