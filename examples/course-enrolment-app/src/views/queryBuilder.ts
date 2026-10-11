import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type ColumnType } from "kysely";
import type { SqlClient } from "effect/sql";
import type { DB } from "./db.generated.ts";

// OPTIONAL: type-checked queries for a projector, with Kysely used only to BUILD the SQL. The library (@crablet/*) does not depend on Kysely; an application that wants it adds it, as this example does
// (docs/guides/add-a-view.md, "Type-checked queries with Kysely").

// The shape of the view tables is GENERATED from the migrated database (scripts/db-types.ts, `npm run db:types`): a migration that changes a view table changes db.generated.ts, and a query that no longer fits stops compiling.
// What the database says is not always what the driver hands back: the generated type of a BIGINT reads as text, and @effect/sql-pg returns a bigint. This maps those columns to what the driver does; every other column is left as generated.
type GeneratedInt8 = ColumnType<string, bigint | number | string, bigint | number | string>;
type DriverInt8 = ColumnType<bigint, bigint | number | string, bigint | number | string>;
type FromDriver<Column> = [Column] extends [GeneratedInt8] ? DriverInt8 : Column;
export type Database = { readonly [Table in keyof DB]: { readonly [Column in keyof DB[Table]]: FromDriver<DB[Table][Column]> } };

// A Kysely with a driver that never opens a connection: it compiles queries and nothing else.
export const qb = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler()
  }
});

// Runs a query Kysely built on the `sql` the projector is given: the same connection and transaction as the view's cursor (ADR-0023), which is what makes a batch handled twice apply once.
export const run = (sql: SqlClient.SqlClient, query: { compile(): { readonly sql: string; readonly parameters: ReadonlyArray<unknown> } }) => {
  const compiled = query.compile();
  return sql.unsafe(compiled.sql, [...compiled.parameters]);
};
