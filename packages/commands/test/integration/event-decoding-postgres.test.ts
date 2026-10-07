// Runs under Node (Testcontainers). ADR-0017: a stored event that its definition cannot read is a TYPED failure naming it, on real Postgres through the real
// executor. (Before: a defect, an HTTP 500 with no way to tell which event, on every later command over that boundary: diagnostic E7.)
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore } from "@crablet/eventstore";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { defineCommand, emit } from "../../src/Command.ts";
import { defineEvent } from "../../src/Event.ts";
import { defineModel } from "../../src/Model.ts";

const Ticked = defineEvent("Ticked", { schema: Schema.Struct({ entityId: Schema.String }), tags: (d) => ({ entity_id: d.entityId }) });
const Count = defineModel({ by: "entity_id", initial: () => ({ n: 0 }) }).on(Ticked, (s) => ({ n: s.n + 1 }));
const Tick = defineCommand({ name: "tick", errors: [], input: Schema.Struct({ entityId: Schema.String }), model: (c) => Count.of({ id: c.entityId }), decide: (_m, c) => emit(Ticked(c)) });

let db: TestDb;
before(async () => { db = await startTestDb(); }, { timeout: 60_000 });
after(async () => { await db.stop(); });
const run = <A, E>(e: Effect.Effect<A, E, any>) =>
  Effect.runPromise(Effect.provide(e, Crablet.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) })) as Effect.Effect<A, E, never>);
const raw = (entity: string, data: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("INSERT INTO crablet_events (type, tags, data, transaction_id) VALUES ('Ticked', ARRAY['entity_id=' || $1], $2::jsonb, pg_current_xact_id()) RETURNING position::text AS position", [entity, data]));
const failuresOf = (exit: any): ReadonlyArray<any> => (exit.cause?.reasons ?? []).filter((r: any) => r._tag === "Fail").map((r: any) => r.error);
const defectsOf = (exit: any): ReadonlyArray<any> => (exit.cause?.reasons ?? []).filter((r: any) => r._tag === "Die");

describe("a stored event that cannot be read", () => {
  it("fails the command with a typed EventDecodingError naming its position, type and issues; again on every later attempt; other entities are unaffected", async () => {
    const id = `drift-${crypto.randomUUID().slice(0, 6)}`;
    const other = `fine-${crypto.randomUUID().slice(0, 6)}`;
    const r = await run(Effect.gen(function* () {
      yield* raw(id, '{"entityId":"' + id + '"}'); // fine
      const bad = (yield* raw(id, '{"entity":"' + id + '","v":1}')) as ReadonlyArray<{ position: string }>; // an older shape: the field was renamed
      const executor = yield* CommandExecutor;
      const first = yield* Effect.exit(executor.run(Tick, { entityId: id }));
      const second = yield* Effect.exit(executor.run(Tick, { entityId: id }));
      const unaffected = yield* Effect.exit(executor.run(Tick, { entityId: other }));
      const state = yield* Effect.exit(Effect.flatMap(EventStore, (es) => Count.of({ id }).load(es)));
      return { first, second, unaffected, state, badPosition: bad[0]!.position };
    }));
    for (const exit of [r.first, r.second, r.state]) {
      assert.strictEqual(defectsOf(exit).length, 0, "a typed failure, not a defect");
      const [error] = failuresOf(exit);
      assert.strictEqual(error._tag, "EventDecodingError");
      assert.strictEqual(error.type, "Ticked");
      assert.strictEqual(String(error.position), r.badPosition);
      assert.ok(/^\d+$/.test(error.transactionId));
      assert.deepStrictEqual(error.issues, [{ path: ["entityId"], message: "Missing key" }]);
      assert.ok(error.message.includes(`position ${r.badPosition}`));
    }
    assert.strictEqual(r.unaffected._tag, "Success", "another entity's commands still work");
  });
});
