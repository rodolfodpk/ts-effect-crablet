# @crablet/db-migrations

The SQL schema, as a plain file bundle: the event log, the command audit, poller progress, the conditional append function and the tag-key table. This repository
owns the schema; applications apply it, they do not write it.

## What it gives you

- **`migrationFiles`** - the migrations V1-V13 in the order to apply them.
- **`sqlDir`** - the directory holding the `.sql` files.

An application applies them with its own tool (the examples use a small `migrate.ts`, and keep their own tables in a separate `db/migration` folder numbered from V100).
Nothing is applied for you.

## Depends on

Nothing.

## Read more

[Tutorial step 2](../../docs/tutorial/02-postgres-and-the-second-rule.md) (running the migration), [ADR-0019](../../docs/adr/0019-storage-visibility-and-the-tag-table.md) (V11, V12).
V11 pauses writers for the length of its backfill: read its header comment before running it on a large table.
