# @crablet/test-support

A throwaway PostgreSQL for integration tests, through Testcontainers. It needs Docker and is a development dependency only.

## What it gives you

- **`startTestDb`** - starts a container, applies the migrations from [`@crablet/db-migrations`](../db-migrations/README.md) and returns `{ container, connInfo, stop() }`.
  `startTestDb({ migrations })` applies a chosen subset, for testing a migration itself; `migrationFiles` and `sqlDir` are re-exported for that.
- **`CatalogDump`** (`/CatalogDump`) - `catalogDump(client)` reads the schema from the catalog (tables and columns in order, constraints, indexes, functions with their definitions, sequences, comments), sorted and with no OIDs, so two databases with the same schema give the same dump. The schema snapshot test compares it with `packages/db-migrations/schema-snapshot.json` ([ADR-0047](../../docs/adr/0047-the-migrations-are-the-schemas-shape.md)).
- **`BrowserSafety`** (`/BrowserSafety`) - `bundleForBrowser(entry)` bundles a module a browser page imports (a contracts module) in-process and reports what it pulled in, so a unit test can fail if it reaches a server-only module (`serverOnly` lists the patterns). Bun-only: use it from `bun test`, not from the Node integration tests.

## Depends on

`@crablet/db-migrations`, `pg`, `@testcontainers/postgresql`.

## Read more

Any `packages/*/test/integration/*.test.ts` is an example of use. Integration tests run with `bun run test:integration` (under Node).
