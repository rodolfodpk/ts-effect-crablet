// Runs under Node (Testcontainers). A command that ends idempotent (a repeat, or a decision that does nothing) has done nothing, so nothing it appended in `prepare` may stay: the executor used to commit
// that transaction while an idempotent result writes no audit row, leaving events with no command behind them (Command.ts, "prepare"). The transaction is now rolled back.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Redacted, Ref } from "effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore } from "@crablet/eventstore";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { defineCommand, emit, noop } from "../../src/Command.ts";
import { defineEvent } from "../../src/Event.ts";

let db: TestDb;
before(async () => { db = await startTestDb(); }, { timeout: 60_000 });
after(async () => { await db.stop(); });

const AppLive = () =>
  Crablet.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.provide(e, AppLive()) as Effect.Effect<A, E, never>);

const Marked = defineEvent("IR_Marked", { schema: Schema.Struct({ id: Schema.String }), tags: (d) => ({ item_id: d.id }) });
const Done = defineEvent("IR_Done", { schema: Schema.Struct({ id: Schema.String, opId: Schema.String }), tags: (d) => ({ item_id: d.id, op_id: d.opId }) });
const input = Schema.Struct({ id: Schema.String, opId: Schema.String });

const count = (type: string, id: string) =>
  run(Effect.flatMap(EventStore, (es) => es.exists(type === "IR_Marked" ? Marked.where({ item_id: id }) : Done.where({ item_id: id }))));

describe("a command that ends idempotent leaves nothing behind", () => {
  it("a decision that does nothing, after `prepare` appended: the append is rolled back", async () => {
    const id = `i-${crypto.randomUUID().slice(0, 8)}`;
    const Leaky = defineCommand({
      name: "ir_leaky", input,
      prepare: (c: any, es: any) => es.append([Marked({ id: c.id })]),
      decide: () => noop("NOTHING_TO_DO")
    });
    const result = await run(Effect.flatMap(CommandExecutor, (ex) => ex.run(Leaky, { id, opId: "1" })));
    assert.equal((result as { wasIdempotent: boolean }).wasIdempotent, true);
    assert.equal(await count("IR_Marked", id), false, "what prepare appended did not survive an idempotent result");
  });

  it("a repeat that loses the final append to a Duplicate, after `prepare` appended: rolled back too", async () => {
    const id = `i-${crypto.randomUUID().slice(0, 8)}`;
    const marks = () =>
      run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<{ n: number }>("SELECT count(*)::int AS n FROM crablet_events WHERE type = 'IR_Marked' AND tags @> ARRAY[$1]::text[]", ["item_id=" + id]))).then((r) => r[0]!.n);
    const exits = await run(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const arrived = yield* Ref.make(0);
        // both pass the idempotency pre-check before either has written; then each appends a mark in `prepare` (no condition), and only one wins the final append
        const Once = defineCommand({
          name: "ir_once", input,
          prepare: (c: any, es: any) =>
            Effect.gen(function* () {
              if ((yield* Ref.updateAndGet(arrived, (n) => n + 1)) === 2) yield* Deferred.succeed(gate, undefined);
              yield* Deferred.await(gate);
              yield* es.append([Marked({ id: c.id })]);
            }),
          idempotentBy: (c: any) => Done.where({ op_id: c.opId }),
          decide: (_: unknown, c: any) => emit(Done(c))
        } as never);
        const ex = yield* CommandExecutor;
        return yield* Effect.all([ex.run(Once as never, { id, opId: "same" }), ex.run(Once as never, { id, opId: "same" })], { concurrency: 2 });
      })
    );
    const created = (exits as ReadonlyArray<{ wasIdempotent: boolean }>).filter((r) => !r.wasIdempotent).length;
    assert.equal(created, 1, "exactly one of them created");
    assert.equal(await marks(), 1, "only the winner's mark: the loser's prepare append was rolled back with it");
  });

  it("a command that creates keeps what its prepare appended", async () => {
    const id = `i-${crypto.randomUUID().slice(0, 8)}`;
    const Creates = defineCommand({ name: "ir_creates", input, prepare: (c: any, es: any) => es.append([Marked({ id: c.id })]), decide: (_: unknown, c: any) => emit(Done(c)) } as never);
    await run(Effect.flatMap(CommandExecutor, (ex) => ex.run(Creates as never, { id, opId: "x" })));
    assert.equal(await count("IR_Marked", id), true);
    assert.equal(await count("IR_Done", id), true);
  });
});
