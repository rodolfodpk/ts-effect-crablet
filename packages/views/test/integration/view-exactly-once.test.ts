// Runs under Node (Testcontainers) - see NOTES.md. A view's writes must apply each event ONCE, even when the same batch is handled twice: by a
// zombie leader and its successor at the same time, or again after a crash between the view's commit and the cursor's update. The projector here
// ADDS (the way the wallet's balance and summary views do), so a repeated batch shows as a doubled total.
//
// Written before the fix (docs/plans/reliability-and-scale-diagnostic.md, F1 residual): the first two tests fail until the cursor is advanced in the
// SAME transaction as the view's writes, as a forward-only compare-and-set that undoes the batch when it matches no row.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { makeViewsProcessor } from "../../src/ViewsModule.ts";
import { viewSubscriptionOf } from "../../src/ViewSubscription.ts";
import { makeTransactionalViewProjector } from "../../src/ViewProjector.ts";
import type { ViewsConfig } from "../../src/ViewsConfig.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | SqlClient.SqlClient | PgClient.PgClient, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  runtime = ManagedRuntime.make(
    Layer.provideMerge(EventStoreLive, pgLayer) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient | PgClient.PgClient, never>
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("CREATE TABLE exactly_once_total (view_name text PRIMARY KEY, total bigint NOT NULL)");
      // Test-only fault injection: while a row for the view is in exactly_once_fail, moving that view's cursor fails (as a crash right after the
      // view's commit would). Only a change of last_position counts, so registering and recording an error still work.
      yield* sql.unsafe("CREATE TABLE exactly_once_fail (view_name text PRIMARY KEY)");
      yield* sql.unsafe(`CREATE FUNCTION exactly_once_fail_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM exactly_once_fail WHERE view_name = NEW.view_name) THEN RAISE EXCEPTION 'injected: cursor update failed'; END IF;
          RETURN NEW;
        END $$`);
      yield* sql.unsafe(`CREATE TRIGGER exactly_once_fail_cursor BEFORE UPDATE ON crablet_view_progress FOR EACH ROW
        WHEN (OLD.last_position IS DISTINCT FROM NEW.last_position) EXECUTE FUNCTION exactly_once_fail_cursor()`);
    })
  );
}, { timeout: 60_000 });

after(async () => {
  await runtime.dispose();
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, EventStore | SqlClient.SqlClient | PgClient.PgClient>) => runtime.runPromise(effect);

const config: ViewsConfig = {
  enabled: true,
  pollingIntervalMs: 100,
  batchSize: 100,
  backoffEnabled: false,
  backoffThreshold: 3,
  backoffMultiplier: 2,
  backoffMaxSeconds: 120,
  leaderElectionRetryIntervalMs: 30_000,
  maxErrors: 5
};

const total = (viewName: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ total: string }>("SELECT total::text FROM exactly_once_total WHERE view_name = $1", [viewName]);
      return rows[0] === undefined ? 0 : Number(rows[0].total);
    })
  );

const cursor = (viewName: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ last_position: string }>("SELECT last_position::text FROM crablet_view_progress WHERE view_name = $1", [viewName]);
      return rows[0] === undefined ? 0n : BigInt(rows[0].last_position);
    })
  );

// An adding projector: `total += n` for every event of the view. `beforeWrite` runs inside the view's transaction, before the write.
const addingProjector = (viewName: string, beforeWrite: Effect.Effect<void> = Effect.void) =>
  makeTransactionalViewProjector(viewName, (event, sql) =>
    Effect.gen(function* () {
      yield* beforeWrite;
      const n = (event.data as { n: number }).n;
      yield* sql.unsafe(
        `INSERT INTO exactly_once_total (view_name, total) VALUES ($1, $2)
         ON CONFLICT (view_name) DO UPDATE SET total = exactly_once_total.total + EXCLUDED.total`,
        [viewName, n]
      );
    })
  );

const processorFor = (viewName: string, eventType: string, projector: Effect.Effect<Effect.Success<ReturnType<typeof addingProjector>>, never, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    return yield* makeViewsProcessor({
      config,
      projectors: [yield* projector],
      subscriptions: [viewSubscriptionOf(viewName, { eventTypes: new Set([eventType]) })],
      instanceId: `instance-${crypto.randomUUID()}`
    });
  });

const appendAdds = (eventType: string, amounts: ReadonlyArray<number>) =>
  run(
    Effect.gen(function* () {
      const store = yield* EventStore;
      for (const n of amounts) yield* store.append([AppendEvent.ofUntagged(eventType, { n })]);
    })
  );

// A latch for `parties` callers: each waits until all have arrived (or `timeoutMs` passes, so a test that never gets there fails instead of hanging).
const latch = (parties: number, timeoutMs = 5000) => {
  let arrived = 0;
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => (release = resolve));
  return Effect.promise(async () => {
    if (++arrived >= parties) release();
    await Promise.race([open, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  });
};

describe("a view applies each event once (real Postgres)", () => {
  it("control: one processor, no fault - the total is the sum of the events", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const viewName = `once-control-${runId}`;
    const eventType = `OnceControl-${runId}`;
    await appendAdds(eventType, [5, 7]);

    const handle = await run(processorFor(viewName, eventType, addingProjector(viewName)));
    await run(handle.service.process(viewName));

    assert.strictEqual(await total(viewName), 12);
    assert.ok((await cursor(viewName)) > 0n, "the cursor moved");
  });

  it("two processors handle the SAME batch at the same time (a zombie and its successor): the total is still the sum, once", { timeout: 30_000 }, async () => {
    const runId = crypto.randomUUID();
    const viewName = `once-race-${runId}`;
    const eventType = `OnceRace-${runId}`;
    await appendAdds(eventType, [5, 7]);

    // Both are inside their transaction, with the same events, before either writes: the overlap is forced, not hoped for.
    const bothInside = latch(2);
    const a = await run(processorFor(viewName, eventType, addingProjector(viewName, bothInside)));
    const b = await run(processorFor(viewName, eventType, addingProjector(viewName, bothInside)));

    await Promise.allSettled([run(a.service.process(viewName)), run(b.service.process(viewName))]);

    assert.strictEqual(await total(viewName), 12, "5 + 7 once; 24 means the batch was applied twice");
  });

  it("a crash after the view committed and before the cursor moved: the retry does not apply the batch again", { timeout: 30_000 }, async () => {
    const runId = crypto.randomUUID();
    const viewName = `once-crash-${runId}`;
    const eventType = `OnceCrash-${runId}`;
    await appendAdds(eventType, [5, 7]);

    const handle = await run(processorFor(viewName, eventType, addingProjector(viewName)));
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("INSERT INTO exactly_once_fail (view_name) VALUES ($1)", [viewName]);
      })
    );
    const first = await run(Effect.exit(handle.service.process(viewName)));
    assert.strictEqual(first._tag, "Failure", "the cursor update was made to fail");
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("DELETE FROM exactly_once_fail WHERE view_name = $1", [viewName]);
      })
    );

    await run(handle.service.process(viewName)); // the retry, as the next tick would do it

    assert.strictEqual(await total(viewName), 12, "5 + 7 once; 24 means the retry applied the batch a second time");
  });
});
