import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { Kind, ViewTableDef } from "./ViewTable.ts";

// Compares what a view declares (ViewTable.ts) with the migrated database. The migration is the truth; a mismatch is a mistake in one of the two, found by a test
// instead of at the first event. Returns the mismatches as text (none = the declarations match).

const PG_TYPE: Record<Kind, string> = {
  text: "text",
  integer: "integer",
  decimal: "numeric",
  bigint: "bigint",
  timestamptz: "timestamp with time zone"
};

interface ColumnRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
  readonly column_default: string | null;
}
interface KeyRow {
  readonly table_name: string;
  readonly column_name: string;
}

export const checkViewTables = (sql: SqlClient.SqlClient, tables: ReadonlyArray<ViewTableDef>): Effect.Effect<ReadonlyArray<string>, SqlError> =>
  Effect.gen(function* () {
    const names = tables.map((t) => t.name);
    const columns = yield* sql.unsafe<ColumnRow>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1)`,
      [names] as Array<never>
    );
    const keys = yield* sql.unsafe<KeyRow>(
      `SELECT kcu.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = current_schema() AND tc.table_name = ANY($1)`,
      [names] as Array<never>
    );
    const problems: Array<string> = [];
    for (const table of tables) {
      const actual = new Map(columns.filter((c) => c.table_name === table.name).map((c) => [c.column_name, c]));
      if (actual.size === 0) {
        problems.push(`${table.name}: the table does not exist`);
        continue;
      }
      const declared = { ...table.key, ...table.columns };
      for (const [name, c] of Object.entries(declared)) {
        const found = actual.get(name);
        if (found === undefined) {
          problems.push(`${table.name}.${name}: the column does not exist`);
          continue;
        }
        if (found.data_type !== PG_TYPE[c.kind]) problems.push(`${table.name}.${name}: declared ${c.kind} (${PG_TYPE[c.kind]}), the database has ${found.data_type}`);
        if ((found.is_nullable === "YES") !== c.isNullable) problems.push(`${table.name}.${name}: declared ${c.isNullable ? "nullable" : "NOT NULL"}, the database has ${found.is_nullable === "YES" ? "nullable" : "NOT NULL"}`);
        if (c.hasDefault && found.column_default === null) problems.push(`${table.name}.${name}: declared with a default, the database has none`);
      }
      // A column the declaration does not know that is NOT NULL without a default would make every insert fail.
      for (const [name, c] of actual) {
        if (!(name in declared) && c.is_nullable === "NO" && c.column_default === null) problems.push(`${table.name}.${name}: NOT NULL without a default in the database, not declared`);
      }
      const dbKey = keys.filter((k) => k.table_name === table.name).map((k) => k.column_name).sort();
      const declaredKey = Object.keys(table.key).sort();
      if (dbKey.join(",") !== declaredKey.join(",")) problems.push(`${table.name}: the primary key is (${dbKey.join(", ")}) in the database, (${declaredKey.join(", ")}) declared`);
    }
    return problems;
  });
