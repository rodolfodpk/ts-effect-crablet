import { Context, Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";

// Port of com.crablet.eventstore.CommandAuditStore - kept as a separate service from EventStore
// (mirroring the Java split) so non-command consumers (views, outbox, automations) aren't exposed
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
}

export class CommandAuditStore extends Context.Tag("CommandAuditStore")<
  CommandAuditStore,
  CommandAuditStoreService
>() {}

const STORE_COMMAND_SQL = `
  INSERT INTO crablet_commands (command_id, transaction_id, type, data, metadata, occurred_at)
  VALUES (COALESCE($1::uuid, gen_random_uuid()), pg_current_xact_id(), $2, $3::jsonb, $4::jsonb, $5::timestamptz)
  ON CONFLICT (command_id) DO NOTHING
`;

const STORE_COMMAND_IF_ABSENT_SQL = `${STORE_COMMAND_SQL} RETURNING true AS inserted`;

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
