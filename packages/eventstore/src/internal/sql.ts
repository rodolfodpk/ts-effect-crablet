import { Effect } from "effect";
import type { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import type { Tag } from "../Tag.ts";
import type { AppendEvent } from "../AppendEvent.ts";
import type { AppendCondition } from "../AppendCondition.ts";
import type { Query } from "../Query.ts";
import type { StreamPosition } from "../StreamPosition.ts";
import { ConcurrencyException, type DCBViolation } from "../DCBViolation.ts";
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

// Mirrors EventStoreImpl.APPEND_EVENTS_IF_SQL (EventStoreImpl.java:97-101) - same 13 positional
// params, same order, same casts. Uses sql.unsafe rather than the tagged template so param
// binding order is explicit and matches Java's stmt.setX(i, ...) call sequence exactly.
//
// PATTERN NOTE - @effect/sql gives two ways to run a query, both used in this codebase:
//   - `sql\`SELECT ... ${value}\`` (tagged template, e.g. Listen.ts's `notify` helper): values are
//     interpolated at call sites and the library builds the parameterized query for you. Reads
//     nicely for small ad hoc queries with few params.
//   - `sql.unsafe(text, paramsArray)` (used here): you write the full SQL text yourself, with
//     explicit `$1, $2, ...` placeholders, and pass the parameter values as a plain array in
//     matching order. "Unsafe" refers only to losing the tagged-template's automatic escaping
//     structure - the values are still sent as bind parameters, not string-concatenated, so this
//     is not a SQL-injection risk as long as the param array (not the query text) is what varies.
//     Preferred here specifically because this query has 13 positional params in an exact,
//     Java-mirrored order - a plain array made that order visually explicit and easy to diff
//     against the Java call site during porting.
const APPEND_EVENTS_IF_SQL = `
  SELECT append_events_if(
    $1::text[], $2::text[], $3::jsonb[],
    $4::text[], $5::text[], $6::bigint,
    $7::text[], $8::text[],
    $9::timestamptz, $10::uuid, $11::bigint,
    $12::text, $13::text
  ) AS result
`;

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

// Port of EventStoreImpl.appendIf (as of the advisory-lock fix in spring-crablet commit
// b11118b8) - append_events_if() itself now takes a decision-model-keyed pg_advisory_xact_lock
// before its snapshot-based conflict check, closing the genuinely-concurrent-race window at the
// SQL layer. This means the TS client needs NO isolation-level games (no SERIALIZABLE bump, no
// transaction wrapper, no commit-time-defect handling) - a plain sql.unsafe call is sufficient,
// unlike the Phase 0 spike's original implementation which predated that fix.
export const appendEventsIf = (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<AppendEvent>,
  condition: AppendCondition,
  options?: AppendOptions
): Effect.Effect<string, ConcurrencyException | SqlError> =>
  Effect.gen(function* () {
    const types = events.map((e) => e.type);
    const tagLiterals = events.map((e) => encodeTagsLiteral(e.tags));
    const dataJsonStrings = events.map((e) => JSON.stringify(e.eventData));

    const concurrencyTypes = condition.concurrencyQuery.items.flatMap((i) => i.eventTypes);
    const concurrencyTags = condition.concurrencyQuery.items.flatMap((i) => flatTagStrings(i.tags));
    const hasConcurrencyCondition = concurrencyTypes.length > 0 || concurrencyTags.length > 0;

    const idempotencyTypes = condition.idempotencyQuery.items.flatMap((i) => i.eventTypes);
    const idempotencyTags = condition.idempotencyQuery.items.flatMap((i) => flatTagStrings(i.tags));
    const hasIdempotencyCondition = idempotencyTypes.length > 0 || idempotencyTags.length > 0;

    const correlationId = yield* CorrelationContext.correlationId;
    const causationId = yield* CorrelationContext.causationId;

    const rows = yield* sql.unsafe<{ result: AppendResultJson }>(APPEND_EVENTS_IF_SQL, [
      types,
      tagLiterals,
      dataJsonStrings,
      hasConcurrencyCondition ? concurrencyTypes : null,
      hasConcurrencyCondition ? concurrencyTags : null,
      hasConcurrencyCondition ? condition.afterPosition.position.toString() : null,
      hasIdempotencyCondition ? idempotencyTypes : null,
      hasIdempotencyCondition ? idempotencyTags : null,
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
      const errorCode = result.error_code ?? "DCB_VIOLATION";
      const message = result.message ?? "append condition violated";
      const violation: DCBViolation = { errorCode, message, matchingEventsCount: 0 };
      return yield* new ConcurrencyException({ message: `AppendCondition violated: ${message}`, violation });
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
  after: StreamPosition
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
      "SELECT type, tags, data, transaction_id, position, occurred_at, correlation_id, causation_id " +
      `FROM crablet_events${whereSql} ORDER BY transaction_id, position ASC`;
    return (yield* sql.unsafe<StoredEventRow>(sqlText, params)) as ReadonlyArray<StoredEventRow>;
  });
