import type { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

// A view's table, declared for the operations a projector may do on it (ADR-0026). The Postgres migration stays the source of truth for the table:
// this declaration says what the projector writes, and `checkViewTables` (ViewTableCheck.ts) compares it with the migrated database, so a column a
// migration renamed or retyped is a failing check, not a failure at the first event.
//
//     const summary = viewTable("wallet_summary_view", {
//       key: { wallet_id: text() },
//       columns: { total_deposits: decimal().default(0), last_transaction_at: timestamptz().nullable() }
//     });
//     summary.upsert({ wallet_id: "w1" }, { add: { total_deposits: 10 }, max: { last_transaction_at: at } });
//
// Operations are DATA (`ViewOp`): a handler returns them, the projector runs them on the `sql` it is given (so they commit with the view's cursor,
// ADR-0023), and `applyInMemory` (ViewMemory.ts) applies the same ones to plain maps for tests.

export type Kind = "text" | "integer" | "decimal" | "bigint" | "timestamptz";

interface ValueOf {
  readonly text: string;
  readonly integer: number;
  readonly decimal: number;
  readonly bigint: bigint;
  // An ISO-8601 instant, as events carry them.
  readonly timestamptz: string;
}

export interface Col<K extends Kind, Null extends boolean, Def extends boolean> {
  readonly kind: K;
  readonly isNullable: Null;
  readonly hasDefault: Def;
  readonly defaultValue: ValueOf[K] | undefined;
  nullable(): Col<K, true, Def>;
  // The value of the database's own DEFAULT for the column. An upsert that does not mention the column starts it from here; `checkViewTables` requires the database to have a default too.
  default(value: ValueOf[K]): Col<K, Null, true>;
}
export type AnyCol = Col<Kind, boolean, boolean>;

const col = <K extends Kind, Null extends boolean, Def extends boolean>(
  kind: K,
  isNullable: Null,
  hasDefault: Def,
  defaultValue: ValueOf[K] | undefined
): Col<K, Null, Def> => ({
  kind,
  isNullable,
  hasDefault,
  defaultValue,
  nullable: () => col(kind, true, hasDefault, defaultValue),
  default: (value) => col(kind, isNullable, true, value)
});

export const text = (): Col<"text", false, false> => col("text", false, false, undefined);
export const integer = (): Col<"integer", false, false> => col("integer", false, false, undefined);
// NUMERIC: a JS number in, and a string out of the driver (the in-memory rows normalise it, ViewMemory.ts).
export const decimal = (): Col<"decimal", false, false> => col("decimal", false, false, undefined);
export const bigint = (): Col<"bigint", false, false> => col("bigint", false, false, undefined);
export const timestamptz = (): Col<"timestamptz", false, false> => col("timestamptz", false, false, undefined);

type Val<C> = C extends Col<infer K, infer N, boolean> ? (N extends true ? ValueOf[K] | null : ValueOf[K]) : never;
type KeyRow<K extends Record<string, AnyCol>> = { readonly [P in keyof K]: Val<K[P]> };
type RequiredCols<C extends Record<string, AnyCol>> = {
  [P in keyof C]: C[P] extends { readonly isNullable: false; readonly hasDefault: false } ? P : never;
}[keyof C];
type InsertRow<K extends Record<string, AnyCol>, C extends Record<string, AnyCol>> = KeyRow<K> & {
  readonly [P in RequiredCols<C>]: Val<C[P]>;
} & { readonly [P in Exclude<keyof C, RequiredCols<C>>]?: Val<C[P]> };
type NumericCols<C extends Record<string, AnyCol>> = {
  [P in keyof C]: C[P] extends { readonly kind: "integer" | "decimal"; readonly isNullable: false } ? P : never;
}[keyof C];
type OrderedCols<C extends Record<string, AnyCol>> = {
  [P in keyof C]: C[P] extends { readonly kind: "integer" | "decimal" | "bigint" | "timestamptz" } ? P : never;
}[keyof C];

export interface Change<C extends Record<string, AnyCol>> {
  // `column = column + amount`: the change an event carries, never a total it recorded.
  readonly add?: { readonly [P in NumericCols<C>]?: number };
  readonly set?: { readonly [P in keyof C]?: Val<C[P]> };
  // `column = GREATEST(column, value)`: a column that only moves forward (a "last seen" instant). NULL counts as smaller than any value.
  readonly max?: { readonly [P in OrderedCols<C>]?: Val<C[P]> };
}

export interface ViewTableDef {
  readonly name: string;
  readonly key: Readonly<Record<string, AnyCol>>;
  readonly columns: Readonly<Record<string, AnyCol>>;
}

export type OnConflict = "ignore" | "replace";

export type ViewOp =
  | { readonly op: "insert"; readonly table: ViewTableDef; readonly row: Readonly<Record<string, unknown>>; readonly onConflict: OnConflict }
  | { readonly op: "update" | "upsert"; readonly table: ViewTableDef; readonly key: Readonly<Record<string, unknown>>; readonly change: Change<Record<string, AnyCol>> }
  | { readonly op: "remove"; readonly table: ViewTableDef; readonly key: Readonly<Record<string, unknown>> }
  | { readonly op: "raw"; readonly run: (sql: SqlClient.SqlClient) => Effect.Effect<void, SqlError, never> };

export interface ViewTable<K extends Record<string, AnyCol>, C extends Record<string, AnyCol>> extends ViewTableDef {
  readonly key: K;
  readonly columns: C;
  // A new row. `ignore`: an existing row with the key stays as it is (the event was applied before); `replace`: the columns given overwrite it.
  readonly insert: (row: InsertRow<K, C>, opts: { readonly onConflict: OnConflict }) => ViewOp;
  // Change the row with the key; no row, no change.
  readonly update: (key: KeyRow<K>, change: Change<C>) => ViewOp;
  // Change the row with the key, or create it from the column defaults plus the amounts given.
  readonly upsert: (key: KeyRow<K>, change: Change<C>) => ViewOp;
  readonly remove: (key: KeyRow<K>) => ViewOp;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export const viewTable = <K extends Record<string, AnyCol>, C extends Record<string, AnyCol>>(
  name: string,
  def: { readonly key: K; readonly columns: C }
): ViewTable<K, C> => {
  const names = [name, ...Object.keys(def.key), ...Object.keys(def.columns)];
  for (const n of names) if (!IDENTIFIER.test(n)) throw new Error(`viewTable "${name}": "${n}" is not a plain lower-case identifier`);
  if (Object.keys(def.key).length === 0) throw new Error(`viewTable "${name}": a table needs at least one key column`);
  const dup = Object.keys(def.key).find((k) => k in def.columns);
  if (dup !== undefined) throw new Error(`viewTable "${name}": "${dup}" is both a key and a column`);
  const table: ViewTableDef = { name, key: def.key, columns: def.columns };
  return {
    ...table,
    key: def.key,
    columns: def.columns,
    insert: (row, opts) => ({ op: "insert", table, row, onConflict: opts.onConflict }),
    update: (key, change) => ({ op: "update", table, key, change: change as Change<Record<string, AnyCol>> }),
    upsert: (key, change) => ({ op: "upsert", table, key, change: change as Change<Record<string, AnyCol>> }),
    remove: (key) => ({ op: "remove", table, key })
  };
};

// The escape hatch: run anything on the `sql` the projector is given, so it stays in the transaction of the view's cursor. It cannot run in memory (`applyInMemory` refuses it).
export const raw = (run: (sql: SqlClient.SqlClient) => Effect.Effect<void, SqlError, never>): ViewOp => ({ op: "raw", run });
