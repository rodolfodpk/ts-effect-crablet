import { Effect } from "effect";
import type { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";

// Port of EventStoreImpl.convertTagsToPostgresArray (EventStoreImpl.java:687-702).
// Deliberately bug-for-bug identical: no escaping of `=`, `,`, `{`, `}` in keys/values -
// this is an existing constraint of the Java implementation, not something to "fix" in the port.
export interface Tag {
  readonly key: string;
  readonly value: string;
}

export function encodeTagsLiteral(tags: ReadonlyArray<Tag>): string {
  if (tags.length === 0) return "{}";
  return `{${tags.map((t) => `${t.key}=${t.value}`).join(",")}}`;
}

export interface EventToAppend {
  readonly type: string;
  readonly tags: ReadonlyArray<Tag>;
  readonly data: unknown;
}

export interface AppendCondition {
  readonly eventTypes?: ReadonlyArray<string>;
  readonly conditionTags?: ReadonlyArray<Tag>;
  readonly afterCursorPosition?: bigint;
}

export interface IdempotencyKey {
  readonly types?: ReadonlyArray<string>;
  readonly tags?: ReadonlyArray<Tag>;
}

export interface AppendParams {
  readonly events: ReadonlyArray<EventToAppend>;
  readonly condition?: AppendCondition;
  readonly idempotency?: IdempotencyKey;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly causationId?: bigint;
  readonly notifyChannel?: string;
  readonly notifyPayload?: string;
}

// NB: no TS constructor-parameter-property shorthand here (e.g. `constructor(readonly x: T)`) -
// that syntax requires real transformation, not mere type-stripping, and would break running
// these files directly under Node's --experimental-strip-types / default type-stripping mode.
export class DcbViolation {
  readonly _tag = "DcbViolation";
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

export class IdempotencyViolation {
  readonly _tag = "IdempotencyViolation";
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

export interface AppendSuccess {
  readonly transactionId: string;
  readonly eventsCount: number;
}

// Mirrors EventStoreImpl.APPEND_EVENTS_IF_SQL (EventStoreImpl.java:97-101) - same 13 positional
// params, same order, same casts. Uses sql.unsafe rather than the tagged template so param
// binding order is explicit and matches Java's stmt.setX(i, ...) call sequence exactly.
const APPEND_EVENTS_IF_SQL = `
  SELECT append_events_if(
    $1::text[], $2::text[], $3::jsonb[],
    $4::text[], $5::text[], $6::bigint,
    $7::text[], $8::text[],
    $9::timestamptz, $10::uuid, $11::bigint,
    $12::text, $13::text
  ) AS result
`;

export const appendEventsIf = (
  sql: SqlClient.SqlClient,
  params: AppendParams
): Effect.Effect<AppendSuccess, DcbViolation | IdempotencyViolation | SqlError> => {
  const hasConcurrencyCondition =
    (params.condition?.eventTypes && params.condition.eventTypes.length > 0) ||
    (params.condition?.conditionTags && params.condition.conditionTags.length > 0);

  const runAppend = Effect.gen(function* () {
    const types = params.events.map((e) => e.type);
    const tagLiterals = params.events.map((e) => encodeTagsLiteral(e.tags));
    const dataJsonStrings = params.events.map((e) => JSON.stringify(e.data));

    // p_condition_tags/p_idempotency_tags are checked via `tags @> ...::text[]` against the flat
    // crablet_events.tags column - a plain flat text[] of "key=value" strings, one array for the
    // whole call (NOT the per-event nested-literal-string encoding p_tags uses above).
    const conditionTypes = params.condition?.eventTypes ?? null;
    const conditionTags = params.condition?.conditionTags
      ? params.condition.conditionTags.map((t) => `${t.key}=${t.value}`)
      : null;
    const afterCursorPosition = params.condition?.afterCursorPosition ?? null;

    const idempotencyTypes = params.idempotency?.types ?? null;
    const idempotencyTags = params.idempotency?.tags
      ? params.idempotency.tags.map((t) => `${t.key}=${t.value}`)
      : null;

    // append_events_if's DCB conflict check is snapshot-based (transaction_id <
    // pg_snapshot_xmin(...)), which cannot see a peer transaction's row until that peer commits.
    // Under plain READ_COMMITTED, two genuinely concurrent appends racing the same condition can
    // both pass the check and both succeed (verified empirically - see NOTES.md and the matching
    // fix in EventStoreImpl.appendIf on the Java side). Bump to SERIALIZABLE only when there's an
    // actual concurrency condition to protect, matching the Java fix's scope exactly.
    if (hasConcurrencyCondition) {
      yield* sql.unsafe("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE", []);
    }

    const rows = yield* sql.unsafe<{ result: AppendResultJson }>(APPEND_EVENTS_IF_SQL, [
      types,
      tagLiterals,
      dataJsonStrings,
      conditionTypes,
      conditionTags,
      afterCursorPosition === null ? null : afterCursorPosition.toString(),
      idempotencyTypes,
      idempotencyTags,
      params.occurredAt.toISOString(),
      params.correlationId,
      params.causationId === undefined ? null : params.causationId.toString(),
      params.notifyChannel ?? null,
      params.notifyPayload ?? null
    ]);

    const result = rows[0]?.result;
    if (!result) {
      return yield* Effect.die("No result from append_events_if");
    }

    if (result.success === false) {
      if (result.error_code === "DCB_VIOLATION") {
        return yield* Effect.fail(new DcbViolation(result.message));
      }
      if (result.error_code === "IDEMPOTENCY_VIOLATION") {
        return yield* Effect.fail(new IdempotencyViolation(result.message));
      }
      return yield* Effect.die(`Unknown append failure: ${JSON.stringify(result)}`);
    }

    return { transactionId: result.transaction_id, eventsCount: result.events_count };
  });

  if (!hasConcurrencyCondition) {
    return runAppend;
  }

  // SET TRANSACTION ISOLATION LEVEL only takes effect for the current transaction, so the
  // isolation bump above requires an explicit transaction wrapper here (unlike Java, which sets
  // it directly on the borrowed JDBC connection before an implicit autocommit statement).
  //
  // FINDING: a SERIALIZABLE write-skew conflict is detected by Postgres at COMMIT time (see the
  // "during commit attempt" detail in the underlying error), and @effect/sql's withTransaction
  // surfaces a COMMIT-time failure as an unrecoverable defect (Die), not a typed SqlError in the
  // E channel - catchTag("SqlError", ...) does NOT see it. Must inspect the full Cause (via
  // catchAllCause) to catch both a mid-transaction typed failure AND a commit-time defect.
  return sql.withTransaction(runAppend).pipe(
    Effect.catchAllCause((cause) => {
      const pgError = findPgSerializationFailure(cause);
      if (pgError) {
        return Effect.fail(
          new DcbViolation(`Concurrent modification (serialization failure): ${pgError.message ?? "40001"}`)
        );
      }
      return Effect.failCause(cause);
    })
  );
};

function findPgSerializationFailure(cause: unknown): { message?: string } | null {
  // Walk Effect's Cause structure (Fail/Die can nest a SqlError, whose own `cause` is the raw
  // node-postgres error carrying `.code`) looking for SQLSTATE 40001, regardless of whether it
  // arrived as a typed failure or a defect.
  const asRecord = cause as Record<string, unknown> | null | undefined;
  if (!asRecord || typeof asRecord !== "object") return null;

  const code = (asRecord as { code?: string }).code;
  if (code === "40001") return asRecord as { message?: string };

  for (const key of ["defect", "error", "cause"] as const) {
    const nested = (asRecord as Record<string, unknown>)[key];
    if (nested) {
      const found = findPgSerializationFailure(nested);
      if (found) return found;
    }
  }
  return null;
}

interface AppendResultJson {
  readonly success: boolean;
  readonly message?: string;
  readonly error_code?: "DCB_VIOLATION" | "IDEMPOTENCY_VIOLATION";
  readonly events_count?: number;
  readonly transaction_id?: string;
}
