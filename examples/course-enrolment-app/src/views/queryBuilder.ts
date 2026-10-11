import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type ColumnType } from "kysely";
import type { SqlClient } from "effect/sql";

// OPTIONAL: type-checked queries for a projector, with Kysely used only to BUILD the SQL. The library (@crablet/*) does not depend on Kysely; an application that wants it adds it, as this example does
// (docs/guides/add-a-view.md, "Type-checked queries with Kysely").

// The shape of the view tables, written by hand: this app has one. A bigger schema would generate it from the migrated database (kysely-codegen) instead.
// `last_position` is a BIGINT: @effect/sql-pg hands it back as a bigint, and a position can be written as a bigint, a number or text.
export interface CourseSeatsViewTable {
  readonly course_id: string;
  readonly capacity: number;
  readonly subscribers: ColumnType<number, number | undefined, number>; // has a default (0): optional on insert
  readonly last_position: ColumnType<bigint, bigint | number | string, bigint | number | string>;
}
export interface Database {
  readonly course_seats_view: CourseSeatsViewTable;
}

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
