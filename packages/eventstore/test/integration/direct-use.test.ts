// Runs under Node (Testcontainers). The guide "use the event store directly" (docs/guides/build), its code (support/direct-use.ts) run on Postgres,
// and the race its condition is for: two lends of one copy at once, exactly one stored.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Exit, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "../../src/EventStore.ts";
import { lendCopy, loansOf } from "../support/direct-use.ts";
import { directUseScenario } from "../support/direct-use-scenario.ts";

let db: TestDb;
let layer: Layer.Layer<EventStore | SqlClient.SqlClient, never>;
before(async () => {
  db = await startTestDb();
  const pg = PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
  layer = Layer.provideMerge(EventStoreLive, pg) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient, never>;
}, { timeout: 60_000 });
after(async () => { await db.stop(); });

const run = <A, E>(effect: Effect.Effect<A, E, EventStore>) => Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

describe("the event store used directly, on Postgres", () => {
  it("the guide's code: lend, refuse, return, read page by page and as a stream, a transaction that fails as a whole", { timeout: 60_000 }, directUseScenario(run));

  it("two lends of one copy at once: exactly one is stored", { timeout: 60_000 }, async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const exits = await run(Effect.all([1, 2].map((n) => Effect.exit(lendCopy(`c-${id}`, `m${n}-${id}`))), { concurrency: 2 }));
    assert.strictEqual(exits.filter(Exit.isSuccess).length, 1);
    const loans = [...(await run(loansOf(`m1-${id}`))), ...(await run(loansOf(`m2-${id}`)))];
    assert.strictEqual(loans.length, 1);
  });
});
