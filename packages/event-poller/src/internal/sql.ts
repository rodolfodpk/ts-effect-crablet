import type { Tag } from "@crablet/eventstore/Tag";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventSelection } from "../EventSelection.ts";
import type { ProgressCursor } from "../ProgressCursor.ts";

// Builds the WHERE clause for an EventSelection - dimensions AND together;
// eventTypes empty = unrestricted, requiredTags = ALL keys present, anyOfTags = ANY key present,
// exactTags = ALL key=value pairs match. requiredTags/anyOfTags query crablet_event_tag_keys (the
// framework's key-presence lookup table: one row per tag key of an event, documented as existing for exactly this purpose);
// exactTags reuses the same `tags @> ARRAY[...]::text[]` containment technique EventStore's own
// queryEvents (packages/eventstore/src/internal/sql.ts) uses against crablet_events.tags directly.
//
// The fetch is a keyset on (transaction_id, position) bounded by `transaction_id < pg_snapshot_xmin(...)`.
// `position` is assigned by nextval() when a row is inserted and `transaction_id` is the xid of the inserting
// transaction; the two can be taken in opposite orders (a transaction with the LOWER xid can get the HIGHER
// position and commit first). The xmin bound alone does not make a position cursor safe: it only says the rows
// below xmin are final, not that no row with a LOWER position is still to come. Ordering by
// (transaction_id, position) does: every transaction with an xid below xmin has finished, so every row that
// appears later has an xid at or above that xmin and therefore sorts after every row already delivered
// (docs/plans/poller-cursor-fix.md, ADR-0012).
// How tag-KEY presence (requiredTags / anyOfTags) is tested: against the derived `crablet_event_tag_keys` table ("table", the default), or by looking at the
// event's own `tags` array ("scan"). The two answer the same question: the key table holds a row per distinct key of the tags that contain '=', the key being what
// is before the first '='. "scan" is the reference: a test compares the two on random data, and it is the one to use if the key table is ever suspected
// (docs/adr/0019-storage-visibility-and-the-tag-table.md).
export type TagKeyStrategy = "table" | "scan";
export interface SelectionQueryOptions {
  readonly tagKeys?: TagKeyStrategy;
}

export interface EventSelectionQuery {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
}

// The selection's own clauses (types / required tags / any-of tags / exact tags), appended to `clauses`
// and `params`. Shared by the poller's fetch and by "is anything still pending up to position p?".
const pushSelectionClauses = (selection: EventSelection, clauses: Array<string>, params: Array<unknown>, strategy: TagKeyStrategy = "table"): void => {
  let paramIndex = params.length + 1;

  if (selection.eventTypes.size > 0) {
    clauses.push(`e.type = ANY($${paramIndex++})`);
    params.push([...selection.eventTypes]);
  }

  for (const key of selection.requiredTags) {
    clauses.push(
      strategy === "scan"
        ? `EXISTS (SELECT 1 FROM unnest(e.tags) u WHERE u LIKE '%=%' AND split_part(u, '=', 1) = $${paramIndex++})`
        : `EXISTS (SELECT 1 FROM crablet_event_tag_keys t WHERE t.position = e.position AND t.key = $${paramIndex++})`
    );
    params.push(key);
  }

  if (selection.anyOfTags.size > 0) {
    clauses.push(
      strategy === "scan"
        ? `EXISTS (SELECT 1 FROM unnest(e.tags) u WHERE u LIKE '%=%' AND split_part(u, '=', 1) = ANY($${paramIndex++}))`
        : `EXISTS (SELECT 1 FROM crablet_event_tag_keys t WHERE t.position = e.position AND t.key = ANY($${paramIndex++}))`
    );
    params.push([...selection.anyOfTags]);
  }

  if (selection.exactTags.size > 0) {
    const literals = [...selection.exactTags.entries()].map(([k, v]) => `${k}=${v}`);
    clauses.push(`e.tags @> $${paramIndex++}::text[]`);
    params.push(literals);
  }
};

export const buildEventSelectionQuery = (
  selection: EventSelection,
  cursor: ProgressCursor,
  batchSize: number,
  options: SelectionQueryOptions = {}
): EventSelectionQuery => {
  const clauses: Array<string> = [];
  const params: Array<unknown> = [];

  // The cursor is a (transaction_id, position) pair, compared in that order - NOT a bare position (see
  // ProgressCursor.ts). Together with the xmin bound below, a row that appears after this fetch always sorts
  // after everything fetched, so the cursor can move past the last row without ever skipping one.
  clauses.push(`(e.transaction_id, e.position) > ($${params.length + 1}::xid8, $${params.length + 2}::bigint)`);
  params.push(cursor.transactionId, cursor.position.toString());

  clauses.push("e.transaction_id < pg_snapshot_xmin(pg_current_snapshot())");

  pushSelectionClauses(selection, clauses, params, options.tagKeys);

  const limitParamIndex = params.length + 1;
  params.push(batchSize);

  const sqlText =
    // transaction_id is xid8, which the Postgres client has no binary codec for: read it as text.
    "SELECT e.type, e.tags, e.data, e.transaction_id::text AS transaction_id, e.position, e.occurred_at, e.correlation_id, e.causation_id " +
    `FROM crablet_events e WHERE ${clauses.join(" AND ")} ORDER BY e.transaction_id ASC, e.position ASC LIMIT $${limitParamIndex}`;

  return { sql: sqlText, params };
};

// Is there any COMMITTED event the selection matches in `(after, upTo]`, in (transaction_id, position) order?
// Unlike the poller's fetch this has no visibility cut-off: it asks about events that exist, not about what the
// poller may safely read yet, so a view whose cursor is behind `upTo` only counts as caught up when none remain.
export const buildPendingSelectionQuery = (
  selection: EventSelection,
  after: ProgressCursor,
  upTo: ProgressCursor,
  options: SelectionQueryOptions = {}
): EventSelectionQuery => {
  const clauses: Array<string> = [];
  const params: Array<unknown> = [];
  clauses.push(`(e.transaction_id, e.position) > ($${params.length + 1}::xid8, $${params.length + 2}::bigint)`);
  params.push(after.transactionId, after.position.toString());
  clauses.push(`(e.transaction_id, e.position) <= ($${params.length + 1}::xid8, $${params.length + 2}::bigint)`);
  params.push(upTo.transactionId, upTo.position.toString());
  pushSelectionClauses(selection, clauses, params, options.tagKeys);
  return { sql: `SELECT 1 AS pending FROM crablet_events e WHERE ${clauses.join(" AND ")} LIMIT 1`, params };
};

// The first look of a consistent read, in ONE statement: where the log ends, and for each view where it is and whether anything it handles is pending between its cursor and the
// write the read waits for (the marker, or the end of the log when there is none). It replaces three statements that depended on one another (the end of the log; the view's
// progress row; `buildPendingSelectionQuery` with those two as its bounds), and reads only the framework's own tables. One row per view, in the order given (`ord`); with no
// views, just the end of the log. A view with no progress row has a null cursor and status. `pending` is computed as `buildPendingSelectionQuery` does, from the same
// selection clauses, up to the write.
export const buildReadCheckQuery = (
  views: ReadonlyArray<{ readonly viewName: string } & EventSelection>,
  marker: ProgressCursor | null,
  options: SelectionQueryOptions = {}
): EventSelectionQuery => {
  if (views.length === 0) {
    return { sql: "SELECT transaction_id::text AS head_xid, position::text AS head_pos FROM crablet_events ORDER BY transaction_id DESC, position DESC LIMIT 1", params: [] };
  }
  const params: Array<unknown> = [marker === null ? null : marker.transactionId, marker === null ? null : marker.position.toString()];
  const selects = views.map((view, ord) => {
    params.push(view.viewName);
    const nameParam = params.length;
    const clauses: Array<string> = [];
    pushSelectionClauses(view, clauses, params, options.tagKeys);
    const selection = clauses.map((c) => ` AND ${c}`).join("");
    // `pending` is a lateral "next matching event" probe, not an EXISTS. Measured on 100,000 events: with the bounds coming from other columns of the same statement the planner
    // does not know them, takes a Seq Scan of crablet_events for the EXISTS (8 ms, growing with the log) and runs it even for a view that is already at the write; the lateral
    // form, with its own "the cursor is behind the write" test and ORDER BY ... LIMIT 1, keeps the (transaction_id, position) index (0.1 ms) and does not run at all for a view
    // that has caught up (it was never run in that case before the statement was fused: `cursor >= write` returns first).
    return `SELECT ${ord} AS ord, h.xid::text AS head_xid, h.pos::text AS head_pos,
       p.last_transaction_id::text AS cur_xid, p.last_position::text AS cur_pos, p.status AS status,
       (n.found IS NOT NULL) AS pending
  FROM h CROSS JOIN w LEFT JOIN crablet_view_progress p ON p.view_name = $${nameParam}
  LEFT JOIN LATERAL (
    SELECT true AS found FROM crablet_events e
     WHERE (COALESCE(p.last_transaction_id, '0'::xid8), COALESCE(p.last_position, 0::bigint)) < (w.xid, w.pos)
       AND (e.transaction_id, e.position) > (COALESCE(p.last_transaction_id, '0'::xid8), COALESCE(p.last_position, 0::bigint))
       AND (e.transaction_id, e.position) <= (w.xid, w.pos)${selection}
     ORDER BY e.transaction_id, e.position LIMIT 1) n ON true`;
  });
  return {
    sql: `WITH head AS (SELECT transaction_id, position FROM crablet_events ORDER BY transaction_id DESC, position DESC LIMIT 1),
     h AS (SELECT (SELECT transaction_id FROM head) AS xid, (SELECT position FROM head) AS pos),
     w AS (SELECT COALESCE($1::xid8, h.xid, '0'::xid8) AS xid, COALESCE($2::bigint, h.pos, 0::bigint) AS pos FROM h)
${selects.join("\nUNION ALL\n")}
ORDER BY ord`,
    params
  };
};

// How much is waiting for a processor: the committed events its selection matches after `cursor`, counted up to `cap` (a processor
// that is days behind does not make the sampler count millions of rows), and the age in seconds of the first of them by `occurred_at`.
// Same predicate as the fetch, minus the xmin bound: this asks what exists, not what the poller may safely read yet.
export const buildBacklogQuery = (
  selection: EventSelection,
  cursor: ProgressCursor,
  cap: number,
  options: SelectionQueryOptions = {}
): EventSelectionQuery => {
  const clauses: Array<string> = [];
  const params: Array<unknown> = [];
  clauses.push(`(e.transaction_id, e.position) > ($${params.length + 1}::xid8, $${params.length + 2}::bigint)`);
  params.push(cursor.transactionId, cursor.position.toString());
  pushSelectionClauses(selection, clauses, params, options.tagKeys);
  params.push(cap);
  return {
    sql:
      "SELECT count(*)::text AS pending, extract(epoch FROM (now() - min(b.occurred_at)))::float8 AS oldest_seconds " +
      `FROM (SELECT e.occurred_at FROM crablet_events e WHERE ${clauses.join(" AND ")} ORDER BY e.transaction_id ASC, e.position ASC LIMIT $${params.length}) b`,
    params
  };
};

export interface StoredEventRow {
  readonly type: string;
  readonly tags: ReadonlyArray<string>;
  readonly data: unknown;
  readonly transaction_id: string;
  readonly position: string;
  readonly occurred_at: Date;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
}

// Duplicated from packages/eventstore/src/EventStore.ts's private parseRow - not re-exported
// through @crablet/eventstore's package.json "exports" map, and small enough that duplicating it
// here is simpler than adding a new cross-package export just for this row shape.
export const parseStoredEventRow = (row: StoredEventRow): StoredEvent => {
  const tags: ReadonlyArray<Tag> = row.tags.map((raw) => {
    const idx = raw.indexOf("=");
    return idx < 0 ? { key: raw, value: "" } : { key: raw.slice(0, idx), value: raw.slice(idx + 1) };
  });
  return {
    type: row.type,
    tags,
    data: row.data,
    transactionId: row.transaction_id,
    position: BigInt(row.position),
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id === null ? null : BigInt(row.causation_id)
  };
};
