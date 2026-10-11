import { Effect } from "effect";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import type { ProjectedView } from "./ProjectedView.ts";
import type { AnyCol, ViewOp, ViewTableDef } from "./ViewTable.ts";

// Applies a view's operations to plain maps, with the same meaning the SQL has (ViewTable.ts): defaults, `add`, `max`, update versus upsert, conflicts, remove.
// For tests: a replayed history gives the rows a view must end with, without a database, and an integration test compares them with what Postgres holds.
// It checks the SQL compiler's semantics, not the handlers' logic (both sides run the same handlers).

export type Row = Record<string, unknown>;
// table name -> (key as text -> row)
export type MemoryDb = Map<string, Map<string, Row>>;

const keyText = (table: ViewTableDef, from: Readonly<Record<string, unknown>>): string =>
  Object.keys(table.key)
    .map((k) => String(from[k]))
    .join("\u0000");

const startRow = (table: ViewTableDef, key: Readonly<Record<string, unknown>>): Row => {
  const row: Row = {};
  for (const k of Object.keys(table.key)) row[k] = key[k];
  for (const [name, c] of Object.entries(table.columns)) row[name] = c.hasDefault ? c.defaultValue : c.isNullable ? null : undefined;
  return row;
};

const larger = (c: AnyCol, a: unknown, b: unknown): unknown => {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  if (c.kind === "timestamptz") return Date.parse(a as string) >= Date.parse(b as string) ? a : b;
  return (a as number | bigint) >= (b as number | bigint) ? a : b;
};

const tableOf = (db: MemoryDb, table: ViewTableDef): Map<string, Row> => {
  const found = db.get(table.name);
  if (found !== undefined) return found;
  const made = new Map<string, Row>();
  db.set(table.name, made);
  return made;
};

const change = (table: ViewTableDef, row: Row, c: { readonly add?: object; readonly set?: object; readonly max?: object }): void => {
  for (const [name, v] of Object.entries(c.add ?? {})) if (v !== undefined) row[name] = (row[name] as number) + (v as number);
  for (const [name, v] of Object.entries(c.set ?? {})) if (v !== undefined) row[name] = v;
  for (const [name, v] of Object.entries(c.max ?? {})) if (v !== undefined) row[name] = larger(table.columns[name]!, row[name], v);
};

export const applyOp = (db: MemoryDb, op: ViewOp): void => {
  if (op.op === "raw") throw new Error("applyInMemory cannot run a raw operation: it needs a database");
  const rows = tableOf(db, op.table);
  switch (op.op) {
    case "insert": {
      const id = keyText(op.table, op.row);
      const existing = rows.get(id);
      if (existing !== undefined) {
        if (op.onConflict === "replace") for (const [k, v] of Object.entries(op.row)) if (v !== undefined) existing[k] = v;
        return;
      }
      const row = startRow(op.table, op.row);
      for (const [k, v] of Object.entries(op.row)) if (v !== undefined) row[k] = v;
      for (const [name, c] of Object.entries(op.table.columns)) if (row[name] === undefined && !c.isNullable) throw new Error(`${op.table.name}.${name} is NOT NULL and has no default`);
      rows.set(id, row);
      return;
    }
    case "update": {
      const row = rows.get(keyText(op.table, op.key));
      if (row !== undefined) change(op.table, row, op.change);
      return;
    }
    case "upsert": {
      const id = keyText(op.table, op.key);
      const existing = rows.get(id);
      if (existing !== undefined) {
        change(op.table, existing, op.change);
        return;
      }
      // A new row: the defaults, then the value each change carries (an `add` on a new row is the amount itself).
      const row = startRow(op.table, op.key);
      for (const [name, v] of [...Object.entries(op.change.add ?? {}), ...Object.entries(op.change.set ?? {}), ...Object.entries(op.change.max ?? {})]) if (v !== undefined) row[name] = v;
      for (const [name, c] of Object.entries(op.table.columns)) if (row[name] === undefined && !c.isNullable) throw new Error(`${op.table.name}.${name} is NOT NULL and has no default`);
      rows.set(id, row);
      return;
    }
    case "remove":
      rows.delete(keyText(op.table, op.key));
      return;
  }
};

export const applyInMemory = (view: ProjectedView, events: ReadonlyArray<StoredEvent>, db: MemoryDb = new Map()): Effect.Effect<MemoryDb, EventDecodingError> =>
  Effect.gen(function* () {
    for (const event of events) for (const op of yield* view.opsOf(event)) applyOp(db, op);
    return db;
  });

// One comparable form for a row from memory and a row from Postgres: NUMERIC comes back from the driver as text, BIGINT as text or bigint, TIMESTAMPTZ as a Date.
export const normalizeRow = (table: ViewTableDef, row: Readonly<Record<string, unknown>>): Row => {
  const out: Row = {};
  for (const [name, c] of Object.entries({ ...table.key, ...table.columns })) {
    const v = row[name];
    out[name] =
      v === null || v === undefined
        ? null
        : c.kind === "decimal" || c.kind === "integer"
          ? Number(v)
          : c.kind === "bigint"
            ? BigInt(v as string | number | bigint)
            : c.kind === "timestamptz"
              ? (v instanceof Date ? v : new Date(v as string)).getTime()
              : v;
  }
  return out;
};

// The rows of a table, normalised and sorted by key, for comparing.
export const rowsOf = (db: MemoryDb, table: ViewTableDef): ReadonlyArray<Row> =>
  [...(db.get(table.name)?.entries() ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => normalizeRow(table, row));
