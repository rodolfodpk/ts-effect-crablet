// Runs under Node (Testcontainers). A command makes one append, and its writer locks (V5) are taken in sorted order, so two commands
// cannot deadlock each other. An APPLICATION transaction that appends twice, in its own order, can still deadlock with a command:
// Postgres detects it (SQLSTATE 40P01) and aborts one of the two. When that is the command, the executor must treat it like a
// Conflict: re-run the whole command in a fresh transaction, so it ends up done.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import * as Schema from "effect/Schema";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore } from "@crablet/eventstore";
import * as LogPosition from "@crablet/eventstore/LogPosition";
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

describe("a lock-order deadlock between a command and an application's own transaction", () => {
  it("the application takes b then a; the command takes a then b; the command is aborted by Postgres, re-run, and done", { timeout: 30_000 }, async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const [a, b] = [`a-${id}`, `b-${id}`];
    const exits = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* EventStore;
        const appTookB = yield* Deferred.make<void>();
        // The application: appends for b (holding b's writer lock to the end of its transaction), waits until the command is
        // blocked on b, then appends for a, which the command holds: a cycle.
        const application = store.withWakeups(sql.withTransaction(Effect.gen(function* () {
          yield* store.append([Touched({ id: b })]);
          yield* Deferred.succeed(appTookB, undefined);
          yield* Effect.sleep("300 millis");
          yield* store.append([Touched({ id: a })]);
        })));
        // The command: waits (in resolve, which reads nothing) until the application holds b, then appends for a and b in one append.
        const touchBoth = defineCommand({
          name: "dl_touch_both",
          input: Schema.Struct({ a: Schema.String, b: Schema.String }),
          resolve: () => Deferred.await(appTookB),
          decide: (_, c) => emit(Touched({ id: c.a }), Touched({ id: c.b }))
        });
        const executor = yield* CommandExecutor;
        return yield* Effect.all([Effect.exit(application), Effect.exit(executor.run(touchBoth, { a, b }))], { concurrency: 2 });
      })
    );
    const [app, command] = exits;
    assert.equal(command!._tag, "Success", JSON.stringify((command as any).cause?.reasons?.map((r: any) => r.error?.message ?? String(r.error ?? r.defect))));
    // The command started waiting first, so its deadlock check runs first and Postgres aborts IT; the application then completes.
    // (Were the application aborted instead, it would fail here, and the executor's retry would not have been exercised.)
    assert.equal(app!._tag, "Success", "the application's transaction completed: the command was the one Postgres aborted");
    const count = (id: string) => run(Effect.flatMap(EventStore, (es) => es.project(Touched.where({ account_id: id }), LogPosition.zero(), [{ eventTypes: [], initialState: 0, transition: (n: number) => n + 1 }])));
    assert.equal((await count(a)).state, 2, "a: the application's event and the command's, once each");
    assert.equal((await count(b)).state, 2, "b: the application's event and the command's, once each");
  });
});
