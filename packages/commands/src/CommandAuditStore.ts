import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

// Kept as a separate service from EventStore so non-command consumers (views, outbox, automations) aren't exposed
// to command-audit concerns. transaction_id is always pg_current_xact_id() - call these within
// the same `sql.withTransaction(...)` scope as the event appends for the linkage to be meaningful.
export interface CommandAuditStoreService {
  readonly storeCommand: (
    commandJson: string,
    commandType: string,
    occurredAt: Date
  ) => Effect.Effect<boolean, SqlError>;

  readonly storeCommandIfAbsent: (
    commandJson: string,
    commandType: string,
    commandId: string,
    occurredAt: Date
  ) => Effect.Effect<boolean, SqlError>;

  // Records one executed command with its metadata (correlation id, actor, ...) and returns its generated id.
  // `dataJson` is what ends up in `crablet_commands.data`: the caller decides how much of the command to keep
  // (see @crablet/commands/CommandAudit for the redaction modes).
  readonly record: (entry: {
    readonly type: string;
    readonly dataJson: string;
    readonly metadataJson: string | null;
    readonly occurredAt: Date;
  }) => Effect.Effect<string, SqlError>;

  // Deletes audit rows older than `before`; returns how many. The audit table is not the source of truth, so this
  // is safe retention (events are untouched).
  readonly purge: (before: Date) => Effect.Effect<number, SqlError>;
}

// Same Context.Service + Layer.effect service pattern as EventStore.ts - see that file's primer for
// the full explanation of what the token/registration split buys you.
export class CommandAuditStore extends Context.Service<CommandAuditStore, CommandAuditStoreService>()("CommandAuditStore") {}

const STORE_COMMAND_SQL = `
  INSERT INTO crablet_commands (command_id, transaction_id, type, data, metadata, occurred_at)
  VALUES (COALESCE($1::uuid, gen_random_uuid()), pg_current_xact_id(), $2, $3::jsonb, $4::jsonb, $5::timestamptz)
  ON CONFLICT (command_id) DO NOTHING
`;

const STORE_COMMAND_IF_ABSENT_SQL = `${STORE_COMMAND_SQL} RETURNING true AS inserted`;

const RECORD_COMMAND_SQL = `
  INSERT INTO crablet_commands (command_id, transaction_id, type, data, metadata, occurred_at)
  VALUES (gen_random_uuid(), pg_current_xact_id(), $1, $2::jsonb, $3::jsonb, $4::timestamptz)
  RETURNING command_id::text AS command_id
`;

export const CommandAuditStoreLive = Layer.effect(
  CommandAuditStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const insert = (
      commandId: string | null,
      commandJson: string,
      commandType: string,
      occurredAt: Date
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql.unsafe(STORE_COMMAND_SQL, [commandId, commandType, commandJson, null, occurredAt.toISOString()]),
        () => true
      );

    const service: CommandAuditStoreService = {
      record: (entry) =>
        Effect.map(
          sql.unsafe<{ command_id: string }>(RECORD_COMMAND_SQL, [entry.type, entry.dataJson, entry.metadataJson, entry.occurredAt.toISOString()]),
          (rows) => rows[0]!.command_id
        ),

      purge: (before) =>
        Effect.map(
          sql.unsafe<{ command_id: string }>("DELETE FROM crablet_commands WHERE occurred_at < $1::timestamptz RETURNING command_id", [before.toISOString()]),
          (rows) => rows.length
        ),

      storeCommand: (commandJson, commandType, occurredAt) =>
        insert(null, commandJson, commandType, occurredAt),

      // ON CONFLICT DO NOTHING means an existing commandId inserts zero rows - report that as
      // `false` (already committed, short-circuit to idempotent) rather than always returning true.
      storeCommandIfAbsent: (commandJson, commandType, commandId, occurredAt) =>
        Effect.gen(function* () {
          const rows = yield* sql.unsafe<{ inserted: boolean }>(STORE_COMMAND_IF_ABSENT_SQL, [
            commandId,
            commandType,
            commandJson,
            null,
            occurredAt.toISOString()
          ]);
          return rows.length > 0;
        })
    };

    return service;
  })
);
