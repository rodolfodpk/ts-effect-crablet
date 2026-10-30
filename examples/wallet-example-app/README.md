# wallet-example-app

The framework at full size: a wallet service with five commands (open, deposit, withdraw, transfer, close), four views, an automation, an outbox and an HTTP API,
all composed in one application sharing one connection pool. Start with the [tutorial](../../docs/tutorial/README.md); come here to see how a larger domain is organised.

## Run it

It needs a Postgres database (`wallet_db` by default). On a **fresh** database the app applies the framework's migrations and its own at start-up; a database that already has the event log is left as it is, so the app can restart (there is no migration runner: [Run it in production](../../docs/guides/operate/run-in-production.md#1-apply-the-migrations)).

```bash
node examples/wallet-example-app/src/index.ts
```

Everything is set by environment variables, all optional. The ones you are most likely to need:

| Variable | Default | What it does |
|---|---|---|
| `WALLET_DB_HOST`, `_PORT`, `_NAME`, `_USER`, `_PASSWORD` | `localhost`, `5432`, `wallet_db`, `postgres`, `postgres` | The database. |
| `PORT` | `8080` | The HTTP port. |
| `WALLET_ROLES` | `all` | What this process runs: `api`, `views`, `automations`, `outbox`, or `all` ([ADR-0022](../../docs/adr/0022-runtime-roles.md)). |
| `WALLET_ADMIN_TOKEN` | unset | Mounts the admin API at `/admin/processors` and the event log at `/admin/events` (owners redacted), behind this bearer token. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Exports metrics, spans and logs ([See it on a dashboard](../../docs/guides/operate/dashboard.md)). |

The rest (the pool, a direct session connection behind a pooler, polling and wake-ups, the statement period, migrations) and the health endpoints
(`/healthz`, `/readyz`, `/status`) are in the [configuration reference](../../docs/reference/configuration.md#the-wallets-environment-variables). How to choose
the values: [Configure it](../../docs/guides/operate/configure.md).

Its architecture as C4 diagrams (context, containers, components): [C4 models](../../docs/concepts/c4-examples.md#wallet).

## Where things are

| Path | What |
|---|---|
| `src/domain/` | events, `WalletModel`, tags, the commands (one file each), the contracts, errors, statement periods |
| `src/views/` | four views declared with `defineView` (what each event does to its tables); `WalletSummaryViewProjector` shows `upsert` with `add` and `max`, `WalletStatementViewProjector` routes by tag |
| `src/automations/` | `WalletOpenedAutomation` - an event issues a follow-up command |
| `src/WalletApp.ts` | composes the commands, views, automation, outbox (with a logging publisher) and the HTTP API |
| `src/api/` | the read endpoints, keyset paging and problem bodies |
| `db/migration/` | this app's own tables (V100 and up) |
| `scripts/` | `generate-openapi.ts` (`bun run docs:api` at the root; writes [`docs/api/wallet-openapi.json`](../../docs/api/wallet-openapi.json)), `verify-events.ts` (decode stored events with the current definitions; run it in CI before a deploy that changes an event), `report-storage.ts` (the space the library's tables use) |
| `test/` | unit tests and `test/integration/` (Docker) |

Read more: [Evolving events](../../docs/guides/build/evolving-events.md) (what `verify-events` and `model-impact.test.ts` are for), [Run it in production](../../docs/guides/operate/run-in-production.md), [configuration](../../docs/reference/configuration.md).
