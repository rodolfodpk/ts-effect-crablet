// Runs under Node (Testcontainers). Writer-side locking (V5) means a command whose `prepare` appends and
// whose own append then reads/writes other entities can deadlock with a mirror-image command. Postgres
// detects it (SQLSTATE 40P01, one transaction is aborted); the executor must treat it like a Conflict:
// re-run the whole command in a fresh transaction, so both commands end up done.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Redacted, Ref } from "effect";
import * as Schema from "effect/Schema";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore } from "@crablet/eventstore";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { defineCommand, emit } from "../../src/Command.ts";
import { defineEvent } from "../../src/Event.ts";
import { all, defineModel } from "../../src/Model.ts";

let db: TestDb;
before(async () => {
  db = await startTestDb();
}, { timeout: 60_000 });
after(async () => {
  await db.stop();
});

const AppLive = () =>
  Crablet.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.provide(e, AppLive()) as Effect.Effect<A, E, never>);

const Touched = defineEvent("DL_Touched", { schema: Schema.Struct({ id: Schema.String }), tags: (d) => ({ account_id: d.id }) });
const Linked = defineEvent("DL_Linked", {
  schema: Schema.Struct({ from: Schema.String, to: Schema.String }),
  tags: (d) => ({ account_id: d.from, other_id: d.to })
});
const Account = defineModel({ by: "account_id", initial: () => ({ touched: 0 }) }).on(Touched, (a) => ({ touched: a.touched + 1 }));

describe("lock-order deadlocks between multi-append commands", () => {
  it("two mirror-image commands (each prepares an append, then reads both entities) both complete", async () => {
    const [a, b] = [`a-${crypto.randomUUID().slice(0, 8)}`, `b-${crypto.randomUUID().slice(0, 8)}`];
    const exits = await run(
      Effect.gen(function* () {
        const arrived = yield* Ref.make(0);
        const gate = yield* Deferred.make<void>();
        // Each command's `prepare` appends a Touched event for its own entity (taking its locks, held to
        // the end of its transaction) and waits until BOTH have done so; then each wants the other's.
        const link = defineCommand({
          name: "dl_link",
          input: Schema.Struct({ from: Schema.String, to: Schema.String }),
          prepare: (c, es) =>
            Effect.gen(function* () {
              yield* es.append([Touched({ id: c.from })]);
              if ((yield* Ref.updateAndGet(arrived, (n) => n + 1)) === 2) yield* Deferred.succeed(gate, undefined);
              yield* Deferred.await(gate);
            }),
          model: (c) => all({ from: Account.of({ id: c.from }), to: Account.of({ id: c.to }) }),
          decide: (_, c) => emit(Linked(c))
        });
        const executor = yield* CommandExecutor;
        return yield* Effect.all(
          [Effect.exit(executor.run(link, { from: a, to: b })), Effect.exit(executor.run(link, { from: b, to: a }))],
          { concurrency: 2 }
        );
      })
    );
    assert.deepEqual(exits.map((e) => e._tag), ["Success", "Success"], JSON.stringify(exits.map((e) => (e as any).cause?.reasons?.map((r: any) => r.error?.message ?? r.error))));
    const linked = await run(
      Effect.flatMap(EventStore, (es) => es.exists(Linked.where({ account_id: a }))) 
    );
    assert.equal(linked, true);
  });
});
