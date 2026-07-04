import { Effect } from "effect";
import type { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import type { Tag } from "./append.ts";

// Port of QuerySqlBuilderImpl.buildWhereClause (QuerySqlBuilderImpl.java:18-70) + the base
// SELECT from EventStoreImpl.java:350-356. Builds:
//   WHERE position > $1 AND ( (type = ANY($2) AND tags @> $3::text[]) OR ... )
// ORDER BY transaction_id, position ASC

export interface QueryItem {
  readonly eventTypes?: ReadonlyArray<string>;
  readonly tags?: ReadonlyArray<Tag>;
}

export interface StoredEvent {
  readonly type: string;
  readonly tags: ReadonlyArray<string>;
  readonly data: unknown;
  readonly transaction_id: string;
  readonly position: string;
  readonly occurred_at: Date;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
}

const BASE_SELECT =
  "SELECT type, tags, data, transaction_id, position, occurred_at, correlation_id, causation_id FROM crablet_events";

export const queryEvents = (
  sql: SqlClient.SqlClient,
  query: ReadonlyArray<QueryItem>,
  afterPosition?: bigint
): Effect.Effect<ReadonlyArray<StoredEvent>, SqlError> =>
  Effect.gen(function* () {
    const params: Array<unknown> = [];
    const clauses: Array<string> = [];
    let paramIndex = 1;

    let positionClause = "";
    if (afterPosition !== undefined && afterPosition > 0n) {
      positionClause = `position > $${paramIndex++}`;
      params.push(afterPosition.toString());
    }

    for (const item of query) {
      const parts: Array<string> = [];
      if (item.eventTypes && item.eventTypes.length > 0) {
        parts.push(`type = ANY($${paramIndex++})`);
        params.push(item.eventTypes);
      }
      if (item.tags && item.tags.length > 0) {
        const prefix = parts.length > 0 ? " AND " : "";
        parts.push(`${prefix}tags @> $${paramIndex++}::text[]`);
        params.push(item.tags.map((t) => `${t.key}=${t.value}`));
      }
      if (parts.length > 0) clauses.push(`(${parts.join("")})`);
    }

    const orClause = clauses.length > 0 ? `(${clauses.join(" OR ")})` : "";

    let whereSql = "";
    if (positionClause && orClause) whereSql = ` WHERE ${positionClause} AND ${orClause}`;
    else if (positionClause) whereSql = ` WHERE ${positionClause}`;
    else if (orClause) whereSql = ` WHERE ${orClause}`;

    const sqlText = `${BASE_SELECT}${whereSql} ORDER BY transaction_id, position ASC`;
    return (yield* sql.unsafe<StoredEvent>(sqlText, params)) as ReadonlyArray<StoredEvent>;
  });
