# @crablet/db-migrations

The SQL schema, as a plain file bundle. This repository owns the schema; applications apply it, they do not write it.

## What it gives you

- **`migrationFiles`** - the migrations in the order to apply them, one file per part of the schema, each in its final shape ([ADR-0047](../../docs/adr/0047-the-migrations-are-the-schemas-shape.md)):

  | File | What it holds |
  |---|---|
  | `V1__crablet_events.sql` | the log, `crablet_events`, and `crablet_event_tag_keys`, the key index the pollers select by |
  | `V2__crablet_append.sql` | the conditional append, `append_events_if` and `append_events_batch`, with the writer locks and the condition and idempotency checks |
  | `V3__crablet_command_audit.sql` | the command audit, `crablet_commands` |
  | `V4__crablet_processor_progress.sql` | the cursors and status of the views, automations and outbox publishers |
  | `V5__crablet_deadlines.sql` | the pending deadlines and the deadlines processor's status |

- **`sqlDir`** - the directory holding the `.sql` files.

An application applies them with its own tool (the examples use a small `migrate.ts`, and keep their own tables in a separate `db/migration` folder numbered from V100).
Nothing is applied for you. `schema-snapshot.json` is the schema they give, read from the catalog; a test compares the two
(`packages/eventstore/test/integration/schema-snapshot.test.ts`).

**A database created before ADR-0047** (with the files V1 to V19) cannot be upgraded to these: its applied versions name files that no longer exist.
Recreate it: `docker compose down -v` in an example, `lab.ts down` and `up` for the kind lab (the database goes with the cluster), or drop the
database and apply the five files.

## Depends on

Nothing.

## Read more

[Tutorial step 2](../../docs/tutorial/02-postgres-and-the-second-rule.md) (running the migration), [ADR-0047](../../docs/adr/0047-the-migrations-are-the-schemas-shape.md)
(why the files are what they are), [ADR-0019](../../docs/adr/0019-storage-visibility-and-the-tag-table.md) (the tag-key table).
