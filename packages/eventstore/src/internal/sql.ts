import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { Tag } from "../Tag.ts";
import type { AppendEvent } from "../AppendEvent.ts";
import type { AppendCondition } from "../AppendCondition.ts";
import type { Query } from "../Query.ts";
import type { LogPosition } from "../LogPosition.ts";
import { Conflict, Duplicate } from "../AppendErrors.ts";
import * as CorrelationContext from "../CorrelationContext.ts";

// Port of EventStoreImpl.convertTagsToPostgresArray (EventStoreImpl.java:687-702).
// Deliberately bug-for-bug identical: no escaping of `=`, `,`, `{`, `}` in keys/values - an
// existing constraint of the Java implementation, not something to "fix" in the port.
function encodeTagsLiteral(tags: ReadonlyArray<Tag>): string {
  if (tags.length === 0) return "{}";
  return `{${tags.map((t) => `${t.key}=${t.value}`).join(",")}}`;
}

function flatTagStrings(tags: ReadonlyArray<Tag>): ReadonlyArray<string> {
  return tags.map((t) => `${t.key}=${t.value}`);
}

// append_events_if takes 11 positional params. Uses sql.unsafe rather than the tagged template so
// the param binding order is explicit.
//
// PATTERN NOTE - effect/sql gives two ways to run a query, both used in this codebase:
//   - `sql\`SELECT ... ${value}\`` (tagged template, e.g. Listen.ts's `notify` helper): values are
//     interpolated at call sites and the library builds the parameterized query for you. Reads
//     nicely for small ad hoc queries with few params.
//   - `sql.unsafe(text, paramsArray)` (used here): you write the full SQL text yourself, with
//     explicit `$1, $2, ...` placeholders, and pass the parameter values as a plain array in
//     matching order. "Unsafe" refers only to losing the tagged-template's automatic escaping
//     structure - the values are still sent as bind parameters, not string-concatenated, so this
//     is not a SQL-injection risk as long as the param array (not the query text) is what varies.
//     Preferred here because this query has many positional params where the exact order matters -
//     a plain array keeps that order visually explicit.
const APPEND_EVENTS_IF_SQL = `
  SELECT append_events_if(
    $1::text[], $2::text[], $3::jsonb[],
    $4::jsonb, $5::bigint, $6::jsonb,
    $7::timestamptz, $8::uuid, $9::bigint,
    $10::text, $11::text
  ) AS result
`;

// A Query is an OR of items; the SQL function evaluates each item as
// (any-of types) AND (all tags) and ORs the results. Items with neither types nor tags carry no
// information and are dropped; when nothing remains there is no condition to check (null).
const conditionItemsJson = (query: Query): string | null => {
  const items = query.items
    .filter((i) => i.eventTypes.length > 0 || i.tags.length > 0)
    .map((i) => ({ types: i.eventTypes, tags: flatTagStrings(i.tags) }));
  return items.length > 0 ? JSON.stringify(items) : null;
};

interface AppendResultJson {
  readonly success: boolean;
  readonly message?: string;
  readonly error_code?: "DCB_VIOLATION" | "IDEMPOTENCY_VIOLATION";
  readonly events_count?: number;
  readonly transaction_id?: string;
}

export interface AppendOptions {
  readonly notifyChannel?: string;
  readonly notifyPayload?: string;
}

// append_events_if() serializes each condition item with a pg_advisory_xact_lock before checking
// for conflicts, closing the genuinely-concurrent-race window at the SQL layer, so the client needs
// no isolation-level control (no SERIALIZABLE bump, no commit-time-defect handling) - a plain
// sql.unsafe call is sufficient. Callers must run at READ COMMITTED (the Postgres default).
export const appendEventsIf = (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<AppendEvent>,
  condition: AppendCondition,
  options?: AppendOptions
): Effect.Effect<string, Conflict | Duplicate | SqlError> =>
  Effect.gen(function* () {
    const types = events.map((e) => e.type);
    const tagLiterals = events.map((e) => encodeTagsLiteral(e.tags));
    const dataJsonStrings = events.map((e) => JSON.stringify(e.eventData));

    const concurrencyItems = conditionItemsJson(condition.concurrencyQuery);
    const idempotencyItems = conditionItemsJson(condition.idempotencyQuery);

    const correlationId = yield* CorrelationContext.correlationId;
    const causationId = yield* CorrelationContext.causationId;

    const rows = yield* sql.unsafe<{ result: AppendResultJson }>(APPEND_EVENTS_IF_SQL, [
      types,
      tagLiterals,
      dataJsonStrings,
      concurrencyItems,
      concurrencyItems === null ? null : condition.afterPosition.position.toString(),
      idempotencyItems,
      new Date().toISOString(),
      correlationId,
      causationId === null ? null : causationId.toString(),
      options?.notifyChannel ?? null,
      options?.notifyPayload ?? null
    ]);

    const result = rows[0]?.result;
    if (!result) {
      return yield* Effect.die("No result from append_events_if");
    }

    if (result.success === false) {
      const message = result.message ?? "append condition violated";
      // The SQL function reports which check refused the append. Idempotency is checked first.
      return result.error_code === "IDEMPOTENCY_VIOLATION"
        ? yield* new Duplicate({ message: `Duplicate operation: ${message}` })
        : yield* new Conflict({ message: `AppendCondition violated: ${message}`, kind: "boundary" });
    }

    if (!result.transaction_id) {
      return yield* Effect.die("append_events_if returned success but no transaction_id");
    }
    return result.transaction_id;
  });

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

// Port of QuerySqlBuilderImpl.buildWhereClause (QuerySqlBuilderImpl.java:18-70) + the base SELECT
// from EventStoreImpl.java:350-356.
export const queryEvents = (
  sql: SqlClient.SqlClient,
  query: Query,
  after: LogPosition
): Effect.Effect<ReadonlyArray<StoredEventRow>, SqlError> =>
  Effect.gen(function* () {
    const params: Array<unknown> = [];
    const clauses: Array<string> = [];
    let paramIndex = 1;

    let positionClause = "";
    if (after.position > 0n) {
      positionClause = `position > $${paramIndex++}`;
      params.push(after.position.toString());
    }

    for (const item of query.items) {
      const parts: Array<string> = [];
      if (item.eventTypes.length > 0) {
        parts.push(`type = ANY($${paramIndex++})`);
        params.push(item.eventTypes);
      }
      if (item.tags.length > 0) {
        const prefix = parts.length > 0 ? " AND " : "";
        parts.push(`${prefix}tags @> $${paramIndex++}::text[]`);
        params.push(flatTagStrings(item.tags));
      }
      if (parts.length > 0) clauses.push(`(${parts.join("")})`);
    }

    const orClause = clauses.length > 0 ? `(${clauses.join(" OR ")})` : "";

    let whereSql = "";
    if (positionClause && orClause) whereSql = ` WHERE ${positionClause} AND ${orClause}`;
    else if (positionClause) whereSql = ` WHERE ${positionClause}`;
    else if (orClause) whereSql = ` WHERE ${orClause}`;

    const sqlText =
      // transaction_id is xid8, which the Postgres client has no binary codec for: read it as text.
      // ORDER BY uses the qualified column so it sorts by the real xid8, not the text alias.
      "SELECT type, tags, data, transaction_id::text AS transaction_id, position, occurred_at, correlation_id, causation_id " +
      `FROM crablet_events${whereSql} ORDER BY crablet_events.transaction_id, position ASC`;
    return (yield* sql.unsafe<StoredEventRow>(sqlText, params)) as ReadonlyArray<StoredEventRow>;
  });
