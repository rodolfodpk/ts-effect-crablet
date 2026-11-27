# @crablet/db-migrations

The SQL schema, as a plain file bundle. This repository owns the schema; applications apply it, they do not write it.

## What it gives you

- **`migrationFiles`** - the migrations in the order to apply them. V1 to V5 are one file per part of the schema, each in its shape at the time
  ([ADR-0047](../../docs/adr/0047-the-migrations-are-the-schemas-shape.md)); from V6 on, each file is a change:

  | File | What it holds |
  |---|---|
  | `V1__crablet_events.sql` | the log, `crablet_events`, and `crablet_event_tag_keys`, the key index the pollers select by |
  | `V2__crablet_append.sql` | the conditional append, `append_events_if` and `append_events_batch`, with the writer locks and the condition and idempotency checks |
  | `V3__crablet_command_audit.sql` | the command audit, `crablet_commands` |
  | `V4__crablet_processor_progress.sql` | the cursors and status of the views, automations and outbox publishers |
  | `V5__crablet_deadlines.sql` | the pending deadlines and the deadlines processor's status |
  | `V6__crablet_append_sees_the_read.sql` | `append_events_if` and `crablet_items_match_any` again, taking the read's snapshot: an event the read could see is not a conflict ([ADR-0048](../../docs/adr/0048-a-conflict-is-what-the-read-did-not-see.md)) |
  | `V7__crablet_event_metadata.sql` | the client's metadata on an event (`crablet_events.metadata`), and `append_events_if` and `append_events_batch` again, taking it ([ADR-0051](../../docs/adr/0051-client-metadata-correlation-and-causation.md)) |

- **`sqlDir`** - the directory holding the `.sql` files.
- **`migrate(conn, app?)`**, **`migrateIfFresh(conn, app?)`**, **`migrateApp(conn, app)`** (`/Migrate`) - apply the framework's files, then the application's
  (`{ dir, files }`, numbered from V100), in one transaction, with a plain `pg` client: deploy-time bootstrapping, before any layer exists. `migrateIfFresh` applies
  only to a database without the event log (a restart leaves it alone), and instances that start together take turns on a transaction lock; `migrateApp` applies only the application's, on top of a test database. The
  application's list is checked first (`problemsWith`): a file below V100, out of order or missing stops it before connecting.

They record nothing, so they are for a fresh database. An existing one needs a migration tool with a history table (Flyway applies these files as they are; see
[Run it in production](../../docs/guides/operate/run-in-production.md)). The examples list their own files in `src/migrate.ts` and keep them in `db/migration`. `schema-snapshot.json` is the schema they give, read from the catalog; a test compares the two
(`packages/eventstore/test/integration/schema-snapshot.test.ts`).

**A database created before ADR-0047** (with the files V1 to V19) cannot be upgraded to these: its applied versions name files that no longer exist.
Recreate it: `docker compose down -v` in an example, `lab.ts down` and `up` for the kind lab (the database goes with the cluster), or drop the
database and apply the files.

## Depends on

`pg` (for `/Migrate` only; the files and their list need nothing).

## Read more

[Tutorial step 2](../../docs/tutorial/02-postgres-and-the-second-rule.md) (running the migration), [ADR-0047](../../docs/adr/0047-the-migrations-are-the-schemas-shape.md)
(why the files are what they are), [ADR-0019](../../docs/adr/0019-storage-visibility-and-the-tag-table.md) (the tag-key table).
