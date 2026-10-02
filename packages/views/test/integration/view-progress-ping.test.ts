// Runs under Node (Testcontainers) - see NOTES.md. A running view pings when it advances: the notification names the view and carries a
// cursor that covers the write that caused it, so a client holding the write's marker can tell when its write is in the view.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import * as ProgressCursorNS from "@crablet/event-poller/ProgressCursor";
import { makeViewsProcessor } from "../../src/ViewsModule.ts";
import { viewSubscriptionOf } from "../../src/ViewSubscription.ts";
import { makeTransactionalViewProjector } from "../../src/ViewProjector.ts";
import { VIEW_PROGRESS_CHANNEL, decodeViewProgressPing } from "../../src/ViewProgress.ts";
import type { ViewsConfig } from "../../src/ViewsConfig.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | SqlClient.SqlClient | PgClient.PgClient, never>;
let listener: Client;
const pings: Array<string> = [];

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
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("CREATE TABLE IF NOT EXISTS ping_rows (id text primary key)")));
  listener = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
  await listener.connect();
  await listener.query(`LISTEN ${VIEW_PROGRESS_CHANNEL}`);
  listener.on("notification", (n) => pings.push(n.payload ?? ""));
}, { timeout: 60_000 });
after(async () => {
  await listener.end();
  await runtime.dispose();
  await db.stop();
});

const config: ViewsConfig = {
  enabled: true,
  pollingIntervalMs: 200,
  batchSize: 100,
  backoffEnabled: false,
  backoffThreshold: 3,
  backoffMultiplier: 2,
  backoffMaxSeconds: 120,
  leaderElectionRetryIntervalMs: 30_000,
  maxErrors: 5
};

const waitFor = async (check: () => boolean, ms = 10_000) => {
  const start = Date.now();
  while (!check() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 50));
};

describe("a view's progress pings when it advances", () => {
  it("the ping names the view and its cursor covers the write that caused it", { timeout: 30_000 }, async () => {
    const runId = crypto.randomUUID();
    const type = `PingEvent-${runId}`;
    const viewName = `ping-view-${runId}`;
    const projector = await runtime.runPromise(
      makeTransactionalViewProjector(viewName, (event, sql) =>
        sql.unsafe("INSERT INTO ping_rows (id) VALUES ($1) ON CONFLICT DO NOTHING", [event.tags.find((t) => t.key === "row")?.value])
      )
    );
    const handle = await runtime.runPromise(
      makeViewsProcessor({
        config,
        projectors: [projector],
        subscriptions: [viewSubscriptionOf(viewName, { eventTypes: new Set([type]) })],
        instanceId: `i-${crypto.randomUUID()}`
      })
    );
    await runtime.runPromise(handle.service.start);
    try {
      const write = await runtime.runPromise(Effect.flatMap(EventStore, (es) => es.append([AppendEvent.of(type, "row", runId, {})])));
      await waitFor(() => pings.some((p) => p.includes(viewName)));

      const mine = await Promise.all(pings.filter((p) => p.includes(viewName)).map((p) => Effect.runPromise(decodeViewProgressPing(p))));
      assert.ok(mine.length >= 1, "the view pinged");
      const last = mine[mine.length - 1]!;
      assert.strictEqual(last.id, viewName);
      // the cursor in the ping is at or past the write's own (transaction_id, position) pair
      const covers = ProgressCursorNS.compare(ProgressCursorNS.of(last.transactionId, BigInt(last.position)), ProgressCursorNS.of(write.transactionId, write.lastPosition));
      assert.ok(covers >= 0, "the ping's cursor covers the write");
    } finally {
      await runtime.runPromise(handle.service.stop);
    }
  });

  it("an idle view does not ping", { timeout: 30_000 }, async () => {
    const runId = crypto.randomUUID();
    const viewName = `idle-view-${runId}`;
    const projector = await runtime.runPromise(makeTransactionalViewProjector(viewName, () => Effect.void));
    const handle = await runtime.runPromise(
      makeViewsProcessor({
        config,
        projectors: [projector],
        subscriptions: [viewSubscriptionOf(viewName, { eventTypes: new Set([`NeverAppended-${runId}`]) })],
        instanceId: `i-${crypto.randomUUID()}`
      })
    );
    await runtime.runPromise(handle.service.start);
    try {
      await new Promise((r) => setTimeout(r, 1500)); // several polls with nothing to deliver
      assert.strictEqual(pings.filter((p) => p.includes(viewName)).length, 0);
    } finally {
      await runtime.runPromise(handle.service.stop);
    }
  });
});
