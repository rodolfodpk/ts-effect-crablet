// Runs under Node (Testcontainers). `@crablet/eventstore/AppendContext` around a command's run: the command's events carry the correlation id
// and the metadata set around it, as a direct append's do (ADR-0051; the guide "use the event store directly").
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql";
import { startTestDb, type TestDb } from "@crablet/test-support";
import * as AppendContext from "@crablet/eventstore/AppendContext";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { defineCommand, emit } from "../../src/Command.ts";
import { defineEvent } from "../../src/Event.ts";

let db: TestDb;
before(async () => {
  db = await startTestDb();
}, { timeout: 60_000 });
after(async () => {
  await db.stop();
});

const run = <A, E>(e: Effect.Effect<A, E, any>) =>
  Effect.runPromise(
    Effect.provide(
      e,
      Crablet.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) })
    ) as Effect.Effect<A, E, never>
  );

const Noted = defineEvent("ContextNoted", { schema: Schema.Struct({ noteId: Schema.String }), tags: (d) => ({ note_id: d.noteId }) });
const note = defineCommand({ name: "context-note", input: Schema.Struct({ noteId: Schema.String }), decide: (_, c) => emit(Noted(c)) });

interface Row {
  correlation_id: string | null;
  metadata: Record<string, unknown> | null;
}
const rowOf = (noteId: string) =>
  run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.unsafe<Row>("SELECT correlation_id::text, metadata FROM crablet_events WHERE type = 'ContextNoted' AND tags @> ARRAY[$1]::text[]", [`note_id=${noteId}`])
    )
  ).then((rows) => rows[0]!);

describe("AppendContext around a command's run", () => {
  it("the command's events carry the correlation id and the metadata", async () => {
    const noteId = crypto.randomUUID();
    const correlation = crypto.randomUUID();
    await run(
      Effect.flatMap(CommandExecutor, (e) => e.run(note, { noteId })).pipe(
        AppendContext.withCorrelationId(correlation),
        AppendContext.withMetadata({ source: "front-desk" })
      )
    );
    assert.deepEqual(await rowOf(noteId), { correlation_id: correlation, metadata: { source: "front-desk" } });
  });

  it("without them, neither is recorded", async () => {
    const noteId = crypto.randomUUID();
    await run(Effect.flatMap(CommandExecutor, (e) => e.run(note, { noteId })));
    assert.deepEqual(await rowOf(noteId), { correlation_id: null, metadata: null });
  });
});
