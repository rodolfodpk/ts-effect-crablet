import type { Tag } from "@crablet/eventstore/Tag";
import type { StoredEvent } from "@crablet/eventstore";
import type { EventSelection } from "../EventSelection.ts";

// Port of the generic parts of EventSelectionWhereClauseBuilder.java - dimensions AND together;
// eventTypes empty = unrestricted, requiredTags = ALL keys present, anyOfTags = ANY key present,
// exactTags = ALL key=value pairs match. requiredTags/anyOfTags query crablet_event_tags (the
// framework's key-presence lookup table, documented as existing for exactly this purpose);
// exactTags reuses the same `tags @> ARRAY[...]::text[]` containment technique EventStore's own
// queryEvents (packages/eventstore/src/internal/sql.ts) uses against crablet_events.tags directly.
//
// Includes a `transaction_id < pg_snapshot_xmin(pg_current_snapshot())` visibility filter, the
// same technique append_events_if() itself uses for its conflict check: position is assigned at
// nextval() time (mid-transaction) but transactions can commit out of order relative to when they
// reserved their position. Without this filter, a poller that advances its cursor to
// MAX(fetched.position) could permanently skip a row from a transaction that reserved a lower
// position but committed later - the row would never become visible to a cursor that has already
// moved past it. Bounding the fetch to positions whose producing transaction is guaranteed no
// longer in-flight means any such gap is picked up on a later poll instead, once safe.
export interface EventSelectionQuery {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
}

export const buildEventSelectionQuery = (
  selection: EventSelection,
  lastPosition: bigint,
  batchSize: number
): EventSelectionQuery => {
  const clauses: Array<string> = [];
  const params: Array<unknown> = [];
  let paramIndex = 1;

  clauses.push(`e.position > $${paramIndex++}`);
  params.push(lastPosition.toString());

  clauses.push("e.transaction_id < pg_snapshot_xmin(pg_current_snapshot())");

  if (selection.eventTypes.size > 0) {
    clauses.push(`e.type = ANY($${paramIndex++})`);
    params.push([...selection.eventTypes]);
  }

  for (const key of selection.requiredTags) {
    clauses.push(
      `EXISTS (SELECT 1 FROM crablet_event_tags t WHERE t.position = e.position AND t.key = $${paramIndex++})`
    );
    params.push(key);
  }

  if (selection.anyOfTags.size > 0) {
    clauses.push(
      `EXISTS (SELECT 1 FROM crablet_event_tags t WHERE t.position = e.position AND t.key = ANY($${paramIndex++}))`
    );
    params.push([...selection.anyOfTags]);
  }

  if (selection.exactTags.size > 0) {
    const literals = [...selection.exactTags.entries()].map(([k, v]) => `${k}=${v}`);
    clauses.push(`e.tags @> $${paramIndex++}::text[]`);
    params.push(literals);
  }

  const limitParamIndex = paramIndex++;
  params.push(batchSize);

  const sqlText =
    "SELECT e.type, e.tags, e.data, e.transaction_id, e.position, e.occurred_at, e.correlation_id, e.causation_id " +
    `FROM crablet_events e WHERE ${clauses.join(" AND ")} ORDER BY e.position ASC LIMIT $${limitParamIndex}`;

  return { sql: sqlText, params };
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
