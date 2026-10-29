import type { Client } from "pg";

// The framework's schema as the database sees it, read from the catalog: every table with its columns in order, its constraints and indexes, every
// function with its full definition, the sequences and every comment. Sorted and with no OIDs, so two databases with the same schema give the same
// dump, and a dump can be committed and compared (packages/eventstore/test/integration/schema-snapshot.test.ts, ADR-0047). Only the `public` schema.
export interface CatalogDump {
  readonly tables: ReadonlyArray<{
    readonly name: string;
    readonly comment: string | null;
    readonly columns: ReadonlyArray<{ readonly name: string; readonly type: string; readonly notNull: boolean; readonly default: string | null; readonly identity: string; readonly comment: string | null }>;
    readonly constraints: ReadonlyArray<{ readonly name: string; readonly definition: string }>;
    readonly indexes: ReadonlyArray<{ readonly name: string; readonly definition: string }>;
  }>;
  readonly functions: ReadonlyArray<{ readonly signature: string; readonly definition: string; readonly comment: string | null }>;
  readonly sequences: ReadonlyArray<{ readonly name: string; readonly type: string; readonly ownedBy: string | null }>;
}

export const catalogDump = async (client: Client): Promise<CatalogDump> => {
  const tables = await client.query<{ oid: number; name: string; comment: string | null }>(`
    SELECT c.oid, c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname`);
  const out: Array<CatalogDump["tables"][number]> = [];
  for (const t of tables.rows) {
    const columns = await client.query(`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS "notNull",
             pg_get_expr(d.adbin, d.adrelid) AS default, a.attidentity::text AS identity, col_description(a.attrelid, a.attnum) AS comment
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`, [t.oid]);
    const constraints = await client.query(`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = $1 ORDER BY conname`, [t.oid]);
    const indexes = await client.query(`
      SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = $1 ORDER BY c.relname`, [t.oid]);
    out.push({ name: t.name, comment: t.comment, columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows });
  }
  const functions = await client.query(`
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature, pg_get_functiondef(p.oid) AS definition,
           obj_description(p.oid, 'pg_proc') AS comment
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
    ORDER BY 1`);
  const sequences = await client.query(`
    SELECT c.relname AS name, format_type(s.seqtypid, NULL) AS type,
           (SELECT t.relname || '.' || a.attname FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid
              JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
            WHERE d.objid = c.oid AND d.deptype IN ('a', 'i') LIMIT 1) AS "ownedBy"
    FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
    ORDER BY c.relname`);
  return { tables: out, functions: functions.rows, sequences: sequences.rows };
};
