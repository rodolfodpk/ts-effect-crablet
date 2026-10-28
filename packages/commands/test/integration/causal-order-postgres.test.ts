// Runs under Node (Testcontainers). Pollers deliver events in (transaction_id, position) order, and that order must follow causality: an event a command
// appends is delivered after every event its decision read (ADR-0033). It holds because a transaction id is assigned at the first write and a command's
// append is its transaction's first write, after the read. The executor makes the database refuse a command whose transaction already wrote.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Cause, Deferred, Effect, Exit, Fiber, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import * as Schema from "effect/Schema";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore } from "@crablet/eventstore";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { defineCommand, emit } from "../../src/Command.ts";
import { defineEvent } from "../../src/Event.ts";
import { defineModel } from "../../src/Model.ts";

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

const Posted = defineEvent("CO_Posted", { schema: Schema.Struct({ id: Schema.String, n: Schema.Number }), tags: (d) => ({ thread_id: d.id }) });
const Thread = defineModel({ by: "thread_id", initial: () => ({ posts: 0 }) }).on(Posted, (s) => ({ posts: s.posts + 1 }));

const postInput = Schema.Struct({ id: Schema.String });
const Post = defineCommand({
  name: "co_post",
  input: postInput,
  model: (c) => Thread.of({ id: c.id }),
  decide: (thread, c) => emit(Posted({ id: c.id, n: thread.posts + 1 }))
});

const orderOf = (id: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<{ n: string; transaction_id: string; position: string }>(
        `SELECT data->>'n' AS n, transaction_id::text AS transaction_id, position::text AS position
         FROM crablet_events WHERE type = 'CO_Posted' AND tags @> ARRAY[$1]::text[] ORDER BY transaction_id, position`,
        [`thread_id=${id}`]
      );
    })
  );

describe("delivery order follows causality (ADR-0033)", () => {
  it("a command whose transaction began BEFORE the event it reads committed still sorts after that event", { timeout: 30_000 }, async () => {
    const id = crypto.randomUUID().slice(0, 8);
    await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const firstCommitted = yield* Deferred.make<void>();
        // The second post opens its transaction first, then waits (in resolve, which reads nothing) until the first post has committed.
        const second = defineCommand({
          name: "co_post_late",
          input: postInput,
          resolve: () => Deferred.await(firstCommitted),
          model: (c) => Thread.of({ id: c.id }),
          decide: (thread, c) => emit(Posted({ id: c.id, n: thread.posts + 1 }))
        });
        const late = yield* Effect.forkChild(executor.run(second, { id }));
        yield* Effect.sleep("100 millis");
        yield* executor.run(Post, { id });
        yield* Deferred.succeed(firstCommitted, undefined);
        yield* Fiber.join(late);
      })
    );
    const rows = await orderOf(id);
    assert.deepStrictEqual(rows.map((r) => r.n), ["1", "2"], "the second post read the first (n = 2) and is delivered after it");
  });

  it("a command run in a transaction that has already written is refused, before it appends anything", { timeout: 30_000 }, async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const exit = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* EventStore;
        const executor = yield* CommandExecutor;
        return yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* store.append([Posted({ id: `other-${id}`, n: 1 })]); // the application's own write: the transaction now has an id
              yield* executor.run(Post, { id });
            })
          )
        );
      })
    );
    assert.ok(Exit.isFailure(exit), "refused");
    assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /already written/);
    // A programming error, not a failure a caller handles: a defect, with what to do about it.
    assert.ok(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isDieReason), "a defect");
    assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /Run the command outside any transaction that writes/);
    assert.deepStrictEqual(await orderOf(id), [], "nothing was appended");
  });
});
