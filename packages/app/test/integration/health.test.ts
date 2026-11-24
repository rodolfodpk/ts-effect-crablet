import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { healthRoutes } from "@crablet/processors-http/Health";
import type { Processors } from "@crablet/modules/Processors";
import * as Outbox from "@crablet/outbox";
import * as Deadlines from "@crablet/deadlines";
import { defineTopic } from "@crablet/outbox/TopicConfig";
import { makeLogPublisher } from "@crablet/outbox/OutboxPublisher";
import * as Crablet from "../../src/index.ts";

let db: TestDb;
before(async () => {
  db = await startTestDb();
}, { timeout: 60_000 });
after(async () => {
  await db.stop();
});

const base = () =>
  Crablet.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) }).pipe(
    // a test that cannot reach its database is a defect of the test, not a failure to handle
    Layer.orDie
  );

const topics = [defineTopic("health-test-events", { publishers: ["log"] })];
const declaration = Crablet.modules(Outbox.module({ topics })).with(Deadlines.module({ commands: [] }));
const polling = { pollingIntervalMs: 100, leaderElectionRetryIntervalMs: 200 };

// The probes served over a `Processors`, with the database's own `SELECT 1` as the ping; `get` answers a GET.
const serve = (processors: Layer.Layer<Processors>) => {
  const routes = Layer.unwrap(Effect.map(Effect.service(SqlClient.SqlClient), (sql) => healthRoutes({ ping: sql`SELECT 1`, instance: "test-1" })));
  const { handler, dispose } = HttpRouter.toWebHandler(routes.pipe(Layer.provide(processors), Layer.provide(base())), { disableLogger: true });
  const get = async (path: string) => {
    const response = await handler(new Request(`http://process.test${path}`));
    return { status: response.status, body: await response.text() };
  };
  return { get, dispose };
};
type Get = ReturnType<typeof serve>["get"];
const statusOf = async (get: Get, until: (modules: ReadonlyArray<{ kind: string; leads: boolean }>) => boolean) => {
  const deadline = Date.now() + 10_000;
  let report = JSON.parse((await get("/status")).body);
  while (!until(report.modules) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    report = JSON.parse((await get("/status")).body);
  }
  return report;
};

// The same probes against a catalog and against a running process (Liskov): both are ready when the database answers, and /status tells them apart.
describe("the health routes over Crablet.catalog and Crablet.processors", () => {
  const cases = [
    {
      name: "a catalog: ready, every module listed, none run",
      layer: () => Crablet.catalog(declaration, { polling }).pipe(Layer.provide(base())),
      until: () => true,
      modules: [{ kind: "outbox", runs: false, leads: false }, { kind: "deadlines", runs: false, leads: false }]
    },
    {
      name: "a process running the deadlines: ready, and it says it leads them",
      layer: () => Crablet.processors(declaration, { run: ["deadlines"], polling }).pipe(Layer.provide(Outbox.publishers(topics, { log: makeLogPublisher() })), Layer.provide(base())),
      until: (modules: ReadonlyArray<{ kind: string; leads: boolean }>) => modules.some((m) => m.kind === "deadlines" && m.leads),
      modules: [{ kind: "outbox", runs: false, leads: false }, { kind: "deadlines", runs: true, leads: true }]
    }
  ];
  for (const c of cases) {
    it(c.name, { timeout: 30_000 }, async () => {
      const { get, dispose } = serve(c.layer());
      try {
        assert.deepStrictEqual(await get("/healthz"), { status: 200, body: "ok" });
        assert.deepStrictEqual(await get("/readyz"), { status: 200, body: "ok" });
        const report = await statusOf(get, c.until);
        assert.strictEqual(report.instance, "test-1");
        assert.deepStrictEqual(report.modules, c.modules);
      } finally {
        await dispose();
      }
    });
  }
});
