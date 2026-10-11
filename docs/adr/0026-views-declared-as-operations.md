# ADR-0026: A view is declared as the operations each event stands for; the migration stays the truth for the tables

## Status

**Accepted** (2026-10-11). Built in `packages/views` (`ViewTable.ts`, `ProjectedView.ts`, `ViewMemory.ts`, `ViewTableCheck.ts`, `internal/ViewOpSql.ts`). Ported: the wallet's four views and the course example's seats view.

## Context

Every view projector was a hand-written `switch` on the event type, a `decodeStored` call per case and SQL text (the wallet: 16 `sql.unsafe` calls; the course example: Kysely). Looking at all five, the writes are of six kinds:
insert a row (ignoring or replacing one that exists), add amounts to columns (creating the row if it is missing), set columns, move a column only forward (`GREATEST`), delete a row, and one event writing to
several rows. Three things were kept true by review only:

- the subscription's event types agreed with the `switch` (two files, kept in step by hand);
- a view adds the change an event carries and never copies a total it recorded (the kind lab found 22 to 28 wallets wrong when the balance view copied `newBalance`);
- the writes go through the `sql` the projector is given, so they commit with the view's cursor (ADR-0023).

A query builder (Kysely, Drizzle) checks the SQL text against the tables. It does none of the three, and it brings a second description of the tables (generated types, or a TypeScript schema that duplicates the migration).

## Decision

A view is declared with `defineView(name, { tables }).on(Event, (data, ctx) => operations)`:

- **Handlers are pure and return operations as data**: `insert(row, { onConflict: "ignore" | "replace" })`, `update(key, { add, set, max })` (no row, no change), `upsert(key, { add, set, max })`
  (a missing row starts from the column defaults plus the amounts), `remove(key)`, and `raw(sql => effect)` as the escape hatch (it still receives the given `sql`). `add` accepts only numeric columns, so
  "apply the change, not a total" is the shape of the API. A column is changed one way in one operation.
- **The declaration gives the projector** (each event is read with its own definition's `decodeStored`, so an unreadable payload fails the batch with `EventDecodingError`; the operations run on the given
  `sql`), **the subscription** (the event types handled), **the tables the view owns** and **an in-memory run** (`applyInMemory`, same semantics as the SQL: defaults, `add`, `max`, update versus upsert).
- **The migration is the truth for the tables.** `viewTable` declares a table's columns (`text`, `integer`, `decimal`, `bigint`, `timestamptz`, `.nullable()`, `.default(v)`) and its key, and
  `checkViewTables` compares them with `information_schema` (existence, type, nullability, defaults, primary key, and a NOT NULL column without a default the code does not know). It reports mismatches; it never
  generates DDL.
- **Idempotency belongs to the processor.** A view's writes are applied once because its batch and its cursor commit together (ADR-0023). The per-event bookkeeping the projectors kept for themselves
  (the wallet's `statement_transactions` junction table, the course seats' `last_position`) is dropped, with migrations. Calling `projector.handle` twice by hand applies twice; the processor is the only caller in production.
- Events are typed structurally (`type` and `decodeStored`), so `@crablet/views` does not depend on `@crablet/commands`; and it depends on no query builder.

## Consequences

- **The in-memory run checks the SQL compiler, not the handlers**: both sides run the same handlers, so a wrong sign in a handler is found by the behavioural tests and the lab, not by that comparison.
- A view that uses `raw` cannot run in memory (`applyInMemory` refuses it with a clear error).
- The database may hold other columns than the declaration: it is a check of what the code writes, not a mirror of the table.
- Reads are out of scope. The wallet reads through `SqlSchema`, the course example through Kysely.
- Rebuilding a view (truncate its tables and replay) is possible, since the module knows the tables, and not built.

## Alternatives considered

- **Kysely** (the course example before this): typed SQL text from types generated from the migrated database. Good for reads; for projections it leaves the three points above to review, and it needs a generated file with its own workflow.
- **Drizzle**: table objects like jOOQ's, but the schema is declared in TypeScript (a second copy of the migration unless introspected), its compiled `select` has no aliases for the camel-case row type when the
  SQL is run elsewhere, and it has its own migration tooling. A spike outside the repo confirmed the SQL it builds with no connection; the rest is from its documentation.
- **Keep hand-written SQL.** Still possible: `makeTransactionalViewProjector` is unchanged, and `raw` runs anything.
