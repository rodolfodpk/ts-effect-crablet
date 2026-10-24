import { DateTime, Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { ViewOp, ViewTableDef } from "../ViewTable.ts";

// Compiles a view operation to one SQL statement. Pure, so its exact output is unit-tested. Identifiers come from the table declaration (checked to be
// plain lower-case names when it is made) and are quoted; values are always parameters.

export interface Compiled {
  readonly text: string;
  readonly params: ReadonlyArray<unknown>;
}

type Data = Exclude<ViewOp, { readonly op: "raw" }>;

const q = (name: string): string => `"${name}"`;
// bigint goes over the wire as text: the driver cannot serialise a JS bigint.
// A bigint goes as text, and an instant (a timestamptz column's DateTime) as ISO-8601 text, which Postgres casts to the column's type.
const param = (value: unknown): unknown => (typeof value === "bigint" ? value.toString() : DateTime.isDateTime(value) ? DateTime.formatIso(value) : value);

const keyColumns = (table: ViewTableDef): ReadonlyArray<string> => Object.keys(table.key);

const assertKnown = (table: ViewTableDef, names: ReadonlyArray<string>): void => {
  for (const n of names) if (!(n in table.key) && !(n in table.columns)) throw new Error(`${table.name}: unknown column "${n}"`);
};

const entries = (o: object | undefined): ReadonlyArray<[string, unknown]> =>
  Object.entries((o ?? {}) as Record<string, unknown>).filter(([, v]) => v !== undefined);

const keyEntries = (table: ViewTableDef, key: Readonly<Record<string, unknown>>): ReadonlyArray<[string, unknown]> =>
  keyColumns(table).map((k) => {
    if (key[k] === undefined) throw new Error(`${table.name}: the key is missing "${k}"`);
    return [k, key[k]] as [string, unknown];
  });

// One column may be changed one way only.
const changes = (table: ViewTableDef, change: { readonly add?: object; readonly set?: object; readonly max?: object }) => {
  const add = entries(change.add);
  const set = entries(change.set);
  const max = entries(change.max);
  const seen = new Set<string>();
  for (const [c] of [...add, ...set, ...max]) {
    if (seen.has(c)) throw new Error(`${table.name}: "${c}" is changed twice in one operation`);
    if (c in table.key) throw new Error(`${table.name}: "${c}" is a key column and cannot be changed`);
    seen.add(c);
  }
  assertKnown(table, [...seen]);
  return { add, set, max };
};

export const compile = (op: Data): Compiled | null => {
  const t = q(op.table.name);
  switch (op.op) {
    case "insert": {
      const keys = keyColumns(op.table);
      const cols = [...keys, ...Object.keys(op.table.columns)].filter((c) => op.row[c] !== undefined);
      assertKnown(op.table, Object.keys(op.row));
      for (const k of keys) if (op.row[k] === undefined) throw new Error(`${op.table.name}: the row is missing the key "${k}"`);
      const values = cols.map((c, i) => `$${i + 1}`);
      const nonKey = cols.filter((c) => !keys.includes(c));
      const conflict =
        op.onConflict === "replace" && nonKey.length > 0
          ? ` ON CONFLICT (${keys.map(q).join(", ")}) DO UPDATE SET ${nonKey.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(", ")}`
          : ` ON CONFLICT (${keys.map(q).join(", ")}) DO NOTHING`;
      return { text: `INSERT INTO ${t} (${cols.map(q).join(", ")}) VALUES (${values.join(", ")})${conflict}`, params: cols.map((c) => param(op.row[c])) };
    }
    case "update": {
      const { add, set, max } = changes(op.table, op.change);
      const keys = keyEntries(op.table, op.key);
      const params: Array<unknown> = [];
      const bind = (v: unknown): string => {
        params.push(param(v));
        return `$${params.length}`;
      };
      const clauses = [
        ...add.map(([c, v]) => `${q(c)} = ${q(c)} + ${bind(v)}`),
        ...set.map(([c, v]) => `${q(c)} = ${bind(v)}`),
        ...max.map(([c, v]) => `${q(c)} = GREATEST(${q(c)}, ${bind(v)})`)
      ];
      if (clauses.length === 0) return null;
      const where = keys.map(([k, v]) => `${q(k)} = ${bind(v)}`).join(" AND ");
      return { text: `UPDATE ${t} SET ${clauses.join(", ")} WHERE ${where}`, params };
    }
    case "upsert": {
      const { add, set, max } = changes(op.table, op.change);
      const keys = keyEntries(op.table, op.key);
      const written = [...keys, ...add, ...set, ...max];
      const cols = written.map(([c]) => c);
      const updates = [
        ...add.map(([c]) => `${q(c)} = ${t}.${q(c)} + EXCLUDED.${q(c)}`),
        ...set.map(([c]) => `${q(c)} = EXCLUDED.${q(c)}`),
        ...max.map(([c]) => `${q(c)} = GREATEST(${t}.${q(c)}, EXCLUDED.${q(c)})`)
      ];
      const target = `ON CONFLICT (${keys.map(([k]) => q(k)).join(", ")})`;
      return {
        text: `INSERT INTO ${t} (${cols.map(q).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ${target} ${updates.length > 0 ? `DO UPDATE SET ${updates.join(", ")}` : "DO NOTHING"}`,
        params: written.map(([, v]) => param(v))
      };
    }
    case "remove": {
      const keys = keyEntries(op.table, op.key);
      return { text: `DELETE FROM ${t} WHERE ${keys.map(([k], i) => `${q(k)} = $${i + 1}`).join(" AND ")}`, params: keys.map(([, v]) => param(v)) };
    }
  }
};

export const runOp = (sql: SqlClient.SqlClient, op: ViewOp): Effect.Effect<void, SqlError, never> => {
  if (op.op === "raw") return op.run(sql);
  const compiled = compile(op);
  return compiled === null ? Effect.void : Effect.asVoid(sql.unsafe(compiled.text, compiled.params as Array<never>));
};
