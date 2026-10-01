// Runs under Node (Testcontainers) - see NOTES.md. `waitUntilProcessed`: read your own writes from a view.
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
import { ViewFailed, WaitTimeout, waitUntilProcessed } from "../../src/WaitUntilProcessed.ts";
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
      yield* sql.unsafe("CREATE TABLE IF NOT EXISTS wait_test_rows (id text primary key)");
    })
  );
}, { timeout: 60_000 });

after(async () => {
  await runtime.dispose();
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, EventStore | SqlClient.SqlClient | PgClient.PgClient>) => runtime.runPromise(effect);

// A slow poll, so that "just appended" is reliably BEFORE the view has seen the event.
const slowViews: ViewsConfig = {
  enabled: true,
  pollingIntervalMs: 400,
  batchSize: 100,
  backoffEnabled: false,
  backoffThreshold: 3,
  backoffMultiplier: 2,
  backoffMaxSeconds: 120,
  leaderElectionRetryIntervalMs: 30_000,
  maxErrors: 5
};

const rowExists = (id: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return (yield* sql.unsafe<{ id: string }>("SELECT id FROM wait_test_rows WHERE id = $1", [id])).length > 0;
    })
  );

const startView = async (viewName: string, eventType: string) => {
  const projector = await run(
    makeTransactionalViewProjector(viewName, (event, sql) =>
      Effect.gen(function* () {
        const id = event.tags.find((t) => t.key === "row")?.value;
        yield* sql.unsafe("INSERT INTO wait_test_rows (id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
      })
    )
  );
  const subscription = viewSubscriptionOf(viewName, { eventTypes: new Set([eventType]) });
  const handle = await run(
    makeViewsProcessor({ config: slowViews, projectors: [projector], subscriptions: [subscription], instanceId: `i-${crypto.randomUUID()}` })
  );
  await run(handle.service.start);
  return { subscription, stop: () => run(handle.service.stop) };
};

describe("waitUntilProcessed", () => {
  it("returns only once the view has processed the event: the row is readable immediately after", { timeout: 30_000 }, async () => {
    const runId = crypto.randomUUID();
    const type = `WaitEvent-${runId}`;
    const view = await startView(`wait-view-${runId}`, type);
    try {
      const { lastPosition, transactionId } = await run(
        Effect.flatMap(EventStore, (es) => es.append([AppendEvent.of(type, "row", runId, {})]))
      );
      assert.equal(await rowExists(runId), false, "the view is asynchronous: it has not seen the event yet");

      await run(waitUntilProcessed(view.subscription, { transactionId, position: lastPosition }));
      assert.equal(await rowExists(runId), true, "after the wait, the write is visible in the view");
    } finally {
      await view.stop();
    }
  });

  it("a null position (an idempotent repeat) returns at once", async () => {
    const view = { viewName: `never-${crypto.randomUUID()}`, eventTypes: new Set<string>(), requiredTags: new Set<string>(), anyOfTags: new Set<string>(), exactTags: new Map<string, string>() };
    await run(waitUntilProcessed(view as never, null, { timeout: "200 millis" }));
  });

  it("the last event being one the view ignores does not hang the wait (the view cannot reach that position)", { timeout: 30_000 }, async () => {
    const runId = crypto.randomUUID();
    const type = `WaitSeen-${runId}`;
    const view = await startView(`wait-view-b-${runId}`, type);
    try {
      const { lastPosition, transactionId } = await run(
        Effect.flatMap(EventStore, (es) =>
          es.append([AppendEvent.of(type, "row", runId, {}), AppendEvent.of(`WaitIgnored-${runId}`, "row", "x", {})])
        )
      );
      // the view's progress can only ever land on the first event's position, which is below lastPosition
      await run(waitUntilProcessed(view.subscription, { transactionId, position: lastPosition }));
      assert.equal(await rowExists(runId), true);
      const progress = await run(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.unsafe<{ p: string }>("SELECT last_position::text AS p FROM crablet_view_progress WHERE view_name = $1", [view.subscription.viewName])
        )
      );
      assert.ok(BigInt(progress[0]!.p) < lastPosition, "the view's own progress never reaches the ignored event's position");
    } finally {
      await view.stop();
    }
  });

  it("a view that is not running: WaitTimeout reports how far it got", async () => {
    const runId = crypto.randomUUID();
    const type = `WaitIdle-${runId}`;
    const subscription = viewSubscriptionOf(`wait-idle-${runId}`, { eventTypes: new Set([type]) });
    const { lastPosition, transactionId } = await run(Effect.flatMap(EventStore, (es) => es.append([AppendEvent.of(type, "row", runId, {})])));

    const error = await run(Effect.flip(waitUntilProcessed(subscription, { transactionId, position: lastPosition }, { timeout: "300 millis", interval: "20 millis" })));
    assert.ok(error instanceof WaitTimeout, `expected WaitTimeout, got ${String(error)}`);
    assert.equal(error.reached, 0n);
    assert.equal(error.position, lastPosition);
  });

  it("a view cursor at a HIGHER position but an EARLIER transaction id has not caught up", async () => {
    const runId = crypto.randomUUID();
    const type = `WaitPair-${runId}`;
    const viewName = `wait-pair-${runId}`;
    const subscription = viewSubscriptionOf(viewName, { eventTypes: new Set([type]) });
    const { lastPosition, transactionId } = await run(
      Effect.flatMap(EventStore, (es) => es.append([AppendEvent.of(type, "row", runId, {})]))
    );
    // The view's cursor is far above the write's position, but belongs to an earlier transaction: in
    // (transaction_id, position) order it is still before the write, and the write's event is still pending.
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(
          "INSERT INTO crablet_view_progress (view_name, status, last_position, last_transaction_id) VALUES ($1, 'ACTIVE', $2, $3::xid8)",
          [viewName, (lastPosition + 1000n).toString(), (BigInt(transactionId) - 1n).toString()]
        );
      })
    );
    const error = await run(
      Effect.flip(
        waitUntilProcessed(subscription, { transactionId, position: lastPosition }, { timeout: "300 millis", interval: "20 millis" })
      )
    );
    assert.ok(error instanceof WaitTimeout, `expected WaitTimeout, got ${String(error)}`);
  });

  it("a FAILED view fails fast instead of waiting out the timeout", async () => {
    const runId = crypto.randomUUID();
    const type = `WaitFailed-${runId}`;
    const viewName = `wait-failed-${runId}`;
    const subscription = viewSubscriptionOf(viewName, { eventTypes: new Set([type]) });
    const { lastPosition, transactionId } = await run(Effect.flatMap(EventStore, (es) => es.append([AppendEvent.of(type, "row", runId, {})])));
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("INSERT INTO crablet_view_progress (view_name, status, last_position) VALUES ($1, 'FAILED', 0)", [viewName]);
      })
    );
    const started = Date.now();
    const error = await run(Effect.flip(waitUntilProcessed(subscription, { transactionId, position: lastPosition }, { timeout: "10 seconds" })));
    assert.ok(error instanceof ViewFailed);
    assert.ok(Date.now() - started < 2000, "failed fast");
  });
});
