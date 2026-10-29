# ADR-0047: The migrations are the schema's shape, not its history

## Status

**Accepted** (2026-10-28). Built: the nineteen migrations V1 to V19 became five, one per part of the schema (`packages/db-migrations/sql`), giving the
same schema; `catalogDump` (`@crablet/test-support/CatalogDump`) and the snapshot it is compared with (`packages/db-migrations/schema-snapshot.json`,
`packages/eventstore/test/integration/schema-snapshot.test.ts`).

## Context

The framework's schema had grown as a history of nineteen files. To know what the append does, one had to find the last of the eight files that defined
`append_events_if` (V1, V4, V5, V6, V7, V15, V16, V17), and of the six for `append_events_batch` (V1, V6, V11, V16, V17, V19). Tables and indexes were
created and later dropped: the model snapshots (V9, V10, then V12), the first tag table (V1, replaced in V11), nine secondary indexes on the progress
tables (V3, dropped in V13), two scan tables nothing used (V3, dropped in V14). The tier 2 breaks (`scripts/breaks.ts`) named, by hand, which file held
the last definition of each function. A reader learned the history before the shape.

The project is pre-release, the packages are not published, and breaking changes are accepted when they are worth it (ADR-0013). No database outside
this repository's own development and the kind lab has the old files applied.

## Decision

1. **One file per part of the schema, holding each object in its final shape**, numbered from V1 again:

   | File | What it holds | From the old files |
   |---|---|---|
   | `V1__crablet_events.sql` | the log: `crablet_events` and its indexes, `crablet_event_tag_keys` | V1, V11, V16, V17, V18 |
   | `V2__crablet_append.sql` | the conditional append: `append_events_if`, `append_events_batch` and their helpers (`crablet_leaf_lock_key`, `crablet_writer_lock_keys`, `crablet_items_match_any`, `crablet_items_duplicate`) | V1, V4 to V7, V11, V15 to V17, V19 |
   | `V3__crablet_command_audit.sql` | `crablet_commands` | V2 |
   | `V4__crablet_processor_progress.sql` | the views', automations' and outbox's progress tables, `crablet_progress_cursor_xid` | V3, V8, V13, V14 |
   | `V5__crablet_deadlines.sql` | `crablet_deadlines`, `crablet_deadline_progress` | V19 |

   A file's comments say why each object is as it is, with the decision record behind it; how it got there is in these records and in git. What only an
   upgrade needed is gone: the `DROP`s of old signatures, the backfills, V11's lock on the events table.
2. **The same schema, checked.** Before the old files were removed, both sets were applied to empty databases and their catalogs dumped (tables and
   columns in order, constraints, indexes, function definitions, sequences, comments): the dumps were identical. The dump of the new set is committed as
   `schema-snapshot.json`, so it is also the old set's.
3. **A test keeps the schema from changing unseen.** `schema-snapshot.test.ts` applies the migrations and compares the dump with the snapshot. A change of
   schema is a new migration plus the snapshot rewritten (`UPDATE_SCHEMA_SNAPSHOT=1`), and the snapshot's diff shows what the migration changed.
   `schema-shape.test.ts` keeps what the upgrade tests of V11 to V18 checked of the final schema: the tag-key table's shape, the progress tables with only
   their primary keys, an `event_id` per event.
4. **A database from before is recreated, not upgraded.** Its Flyway history (the kind lab) or its applied files name versions that no longer exist.
   Drop the database and apply the five files: `docker compose down -v` for the examples, and for the kind lab `lab.ts down` then `lab.ts up` (the
   database goes with the cluster).
5. **From here, migrations are history again.** A change is a new file, V6 and on, never an edit of one that may have been applied. This consolidation is
   the exception, made once before a first release.

## Consequences

- The append is one file to read, and the breaks name one file (`V2__crablet_append`). A break's text must be unique in it, so one names more of its
  line than before.
- The decision records before this one cite files that no longer exist (`V15__crablet_append_requires_fresh_transaction.sql` and the like). They are left
  as written; the table above says where each one's content now lives, and git has the files.
- The upgrade tests of V11, V12, V13, V14 and V18 are gone: there is no earlier state to upgrade from. The storage diagnostic's experiment on the old tag
  table (E9b) is gone with that table; its results are in ADR-0019.
- `crablet_progress_cursor_xid` stays: it gives a progress row with only a position the transaction id half of its cursor (ADR-0012), and is tested on
  its own. Nothing in a fresh database needs it; removing it would be a schema change of its own.
