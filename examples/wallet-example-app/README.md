# wallet-example-app

The framework at full size: a wallet service with five commands (open, deposit, withdraw, transfer, close), four views, an automation, an outbox and an HTTP API,
all composed in one application sharing one connection pool. Start with the [tutorial](../../docs/tutorial/README.md); come here to see how a larger domain is organised.

## Run it

It needs a Postgres database (`wallet_db` by default). On a **fresh** database the app applies the framework's migrations and its own at start-up; a database that already has the event log is left as it is, so the app can restart (there is no migration runner: [Run it in production](../../docs/guides/run-in-production.md#1-apply-the-migrations)).

```bash
node examples/wallet-example-app/src/index.ts
```

Connection (all optional): `WALLET_DB_HOST`, `WALLET_DB_PORT`, `WALLET_DB_NAME`, `WALLET_DB_USER`, `WALLET_DB_PASSWORD`; the API listens on `PORT` (8080). `WALLET_DB_POOL` sets the most connections the pool may open (unset: the library's default of 10; [how to size it](../../docs/guides/run-in-production.md#size-the-pool)).
`WALLET_ROLES` picks what this process runs: a comma-separated list of `api`, `views`, `automations`, `outbox`, or `all` (unset: `all`, everything in one process). A process without `api` serves only `GET /healthz` on `PORT`; the admin API is mounted by the `api` role. An invalid value stops the start-up ([ADR-0022](../../docs/adr/0022-runtime-roles.md)).

`WALLET_POLL_MS` (default 1000) and `WALLET_BACKOFF_MAX_SECONDS` (default 120) set how often the processors poll and how long an idle one waits; `WALLET_WAKEUPS` (`coalesced` by default, `inline` or `off`) sets how appends notify them. Profiles, with measurements: [Polling and wake-ups](../../docs/guides/run-in-production.md#polling-and-wake-ups).

Two more are off unless set: `OTEL_EXPORTER_OTLP_ENDPOINT` exports metrics, spans and logs ([See it on a dashboard](../../docs/guides/dashboard.md)), and `WALLET_ADMIN_TOKEN` mounts the processors admin API at `/admin/processors` behind that bearer token ([`@crablet/processors-http`](../../packages/processors-http/README.md), with a page for it: [`processors-admin-ui`](../processors-admin-ui/README.md)).

Its architecture as C4 diagrams (context, containers, components): [C4 models](../../docs/c4-examples.md#wallet).

## Where things are

| Path | What |
|---|---|
| `src/domain/` | events, `WalletModel`, tags, the commands (one file each), the contracts, errors, statement periods |
| `src/views/` | four projectors; `WalletStatementViewProjector` is the worked example of an idempotent projector |
| `src/automations/` | `WalletOpenedAutomation` - an event issues a follow-up command |
| `src/WalletApp.ts` | composes the commands, views, automation, outbox (with a logging publisher) and the HTTP API |
| `src/api/` | the read endpoints, keyset paging and problem bodies |
| `db/migration/` | this app's own tables (V100 and up) |
| `scripts/` | `generate-openapi.ts` (`bun run docs:api` at the root; writes [`docs/api/wallet-openapi.json`](../../docs/api/wallet-openapi.json)), `verify-events.ts` (decode stored events with the current definitions; run it in CI before a deploy that changes an event), `report-storage.ts` (the space the library's tables use) |
| `test/` | unit tests and `test/integration/` (Docker) |

Read more: [Evolving events](../../docs/evolving-events.md) (what `verify-events` and `model-impact.test.ts` are for), [Reference: operating it](../../docs/reference.md#operating-it).
