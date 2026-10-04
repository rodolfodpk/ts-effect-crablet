import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import * as ProgressCursor from "@crablet/event-poller/ProgressCursor";

// The greatest committed point in the log, in the (transaction_id, position) order every cursor uses (ADR-0012): "everything committed when
// this was asked". An empty log is the zero cursor, which every view has already reached. Uses the (transaction_id, position) index.
//
// The aliases differ from the column names on purpose: an ORDER BY name resolves to an output column first, so `AS position` would sort the
// text (see NOTES, "Read consistency, phase 0").
export const headOfLog: Effect.Effect<ProgressCursor.ProgressCursor, SqlError, SqlClient.SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql.unsafe<{ transaction_id_text: string; position_text: string }>(
    "SELECT transaction_id::text AS transaction_id_text, position::text AS position_text FROM crablet_events ORDER BY transaction_id DESC, position DESC LIMIT 1"
  );
  const row = rows[0];
  return row === undefined ? ProgressCursor.zero : ProgressCursor.of(row.transaction_id_text, BigInt(row.position_text));
});
