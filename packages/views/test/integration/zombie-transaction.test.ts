// Runs under Node (Testcontainers). A client that vanishes in the middle of a transaction (a silent network partition: no FIN, no RST) leaves the
// server's session "idle in transaction", and the views deliver nothing committed after that transaction began until the server ends it (no event
// is delivered while an older transaction is open: that is what makes "no event is skipped" true). Without `idle_in_transaction_session_timeout`
// the server ends it when its TCP keepalives give up (minutes with a managed database's settings); with it, after the timeout. The leader's lease
// (ADR-0045) covers only the lock session: this is any pod's transaction, a command's or a view batch's.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Effect, Fiber, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive, type StoredEvent } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { viewsOf } from "../fixtures/viewsOf.ts";
import { makeViewsProcessor } from "../../src/ViewsModule.ts";
import { viewSubscriptionOf } from "../../src/ViewSubscription.ts";
import type { ViewProjector } from "../../src/ViewProjector.ts";

type Services = EventStore | SqlClient.SqlClient | PgClient.PgClient;
type Rt = ManagedRuntime.ManagedRuntime<Services, never>;
let db: TestDb;
let direct: Rt;

const runtimeTo = (port: number, startupParameters?: Record<string, string>): Rt =>
  ManagedRuntime.make(
    Layer.provideMerge(
      EventStoreLive,
      PgClient.layer({
        host: port === db.connInfo.port ? db.connInfo.host : "127.0.0.1",
        port,
        database: db.connInfo.database,
        username: db.connInfo.username,
        password: Redacted.make(db.connInfo.password),
        ...(startupParameters === undefined ? {} : { startupParameters })
      })
    ) as unknown as Layer.Layer<Services, never>
  );

before(async () => {
  db = await startTestDb();
  direct = runtimeTo(db.connInfo.port);
}, { timeout: 60_000 });
after(async () => {
  await direct.dispose();
  await db.stop();
});

// A proxy to Postgres that can be cut silently (as leader-partition.test.ts's), and then closed.
const partitionableProxy = async () => {
  let cut = false;
  const sockets: Array<net.Socket> = [];
  const server = net.createServer((client) => {
    const upstream = net.connect(db.connInfo.port, db.connInfo.host);
    sockets.push(client, upstream);
    client.on("data", (d) => { if (!cut) upstream.write(d); });
    upstream.on("data", (d) => { if (!cut) client.write(d); });
    client.on("error", () => {});
    upstream.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    cut: () => { cut = true; },
    close: () => { for (const s of sockets) s.destroy(); server.close(); }
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A pod (through the proxy) begins a transaction that appends, and vanishes before it commits; then an event is committed directly. Returns how long
// after the cut a view saw that event (null: not within `watchMs`), and whether the vanished pod's event was ever seen.
const vanishMidTransaction = async (startupParameters: Record<string, string> | undefined, watchMs: number) => {
  const runId = crypto.randomUUID();
  // Two types: an append locks its (type, tag) pairs (an untagged event, its type), so the direct append must not share the vanished one's.
  const vanishedType = `ZombieTxVanished-${runId}`;
  const directType = `ZombieTxDirect-${runId}`;
  const seen: Array<StoredEvent> = [];
  const projector: ViewProjector = { viewName: `zombie-${runId}`, handle: (events) => Effect.sync(() => (seen.push(...events), events.length)) };
  const views = await direct.runPromise(
    makeViewsProcessor({
      config: { pollingIntervalMs: 100, backoffEnabled: false, leaderElectionRetryIntervalMs: 200 },
      views: viewsOf([projector], [viewSubscriptionOf(projector.viewName, { eventTypes: new Set([vanishedType, directType]) })]),
      instanceId: `zombie-${runId}`
    })
  );
  const proxy = await partitionableProxy();
  const pod = runtimeTo(proxy.port, startupParameters);
  try {
    await direct.runPromise(views.service.start);
    const open = await pod.runPromise(
      Effect.forkDetach(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.withTransaction(Effect.andThen(Effect.flatMap(EventStore, (store) => store.append([AppendEvent.ofUntagged(vanishedType, { from: "vanished" })])), Effect.never))
        )
      )
    );
    await sleep(500); // the append has run; the transaction is open
    proxy.cut();
    const cutAt = Date.now();
    await direct.runPromise(Effect.flatMap(EventStore, (store) => store.append([AppendEvent.ofUntagged(directType, { from: "direct" })])));

    let seenAfter: number | null = null;
    while (Date.now() - cutAt < watchMs) {
      if (seen.some((e) => (e.data as { from: string }).from === "direct")) {
        seenAfter = Date.now() - cutAt;
        break;
      }
      await sleep(100);
    }
    // The vanished side is not waited for: its rollback goes to a connection that answers nothing.
    void pod.runPromise(Fiber.interrupt(open)).catch(() => {});
    return { seenAfter, vanishedSeen: seen.some((e) => (e.data as { from: string }).from === "vanished") };
  } finally {
    await direct.runPromise(views.service.stop);
    proxy.close();
    void pod.dispose().catch(() => {});
  }
};

describe("a pod that vanishes in the middle of a transaction", () => {
  it("without idle_in_transaction_session_timeout, the views deliver nothing committed after it began, for as long as the server keeps the session", { timeout: 30_000 }, async () => {
    const { seenAfter } = await vanishMidTransaction(undefined, 6_000);
    assert.strictEqual(seenAfter, null, "the view is stalled behind the vanished pod's open transaction");
  });

  it("with idle_in_transaction_session_timeout set on the pod's connections, the server rolls it back after the timeout and the views go on", { timeout: 30_000 }, async () => {
    const { seenAfter, vanishedSeen } = await vanishMidTransaction({ idle_in_transaction_session_timeout: "2000" }, 10_000);
    assert.ok(seenAfter !== null, "the view saw the event committed after the vanished transaction began");
    assert.ok(seenAfter >= 1_000 && seenAfter < 6_000, `about the timeout after the cut (${seenAfter} ms)`);
    assert.strictEqual(vanishedSeen, false, "the vanished pod's append was rolled back");
  });
});
