import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type ColumnType, type Compilable } from "kysely";
import type { SqlClient } from "effect/sql";
import type { DB } from "./db.generated.ts";

// This app's queries are written with Kysely, which here only BUILDS the SQL (it never opens a connection); `run` executes it on the `sql` of the projector or the read. The library (@crablet/*) does not depend on Kysely: an
// application that wants it adds it, as this example does (docs/guides/database-workflow.md, docs/guides/add-a-view.md).

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

// Runs a query Kysely built on the `sql` it is given: the same connection and transaction as the view's cursor (ADR-0023), which is what makes a batch handled twice apply once.
// The rows of a `select` are typed from the query (the columns it names, with the types of db.generated.ts), so a read needs no hand-written row type.
export const run = <Row extends object>(sql: SqlClient.SqlClient, query: Compilable<Row>) => {
  const compiled = query.compile();
  return sql.unsafe<Row>(compiled.sql, [...compiled.parameters]);
};
