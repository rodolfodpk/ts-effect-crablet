# wallet-example-app

The framework at full size: a wallet service with five commands (open, deposit, withdraw, transfer, close), four views, an automation, an outbox and an HTTP API,
all composed in one application sharing one connection pool. Start with the [tutorial](../../docs/tutorial/README.md); come here to see how a larger domain is organised.

## Run it

It needs a Postgres database (`wallet_db` by default). On a **fresh** database the app applies the framework's migrations and its own at start-up; a database that already has the event log is left as it is, so the app can restart (there is no migration runner: [Run it in production](../../docs/guides/run-in-production.md#1-apply-the-migrations)).

```bash
node examples/wallet-example-app/src/index.ts
```

Connection (all optional): `WALLET_DB_HOST`, `WALLET_DB_PORT`, `WALLET_DB_NAME`, `WALLET_DB_USER`, `WALLET_DB_PASSWORD`; the API listens on `PORT` (8080).

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
