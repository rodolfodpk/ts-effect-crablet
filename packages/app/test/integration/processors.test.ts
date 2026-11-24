import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { Processors } from "@crablet/modules/Processors";
import * as Views from "@crablet/views";
import * as Automations from "@crablet/automations";
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

const topics = [defineTopic("app-test-events", { publishers: ["log"] })];
const declaration = Crablet.modules(Automations.module({ automations: [] }))
  .with(Outbox.module({ topics }))
  .with(Deadlines.module({ commands: [] }));
const polling = { pollingIntervalMs: 100, leaderElectionRetryIntervalMs: 200 };

const locksHeld = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ key: string }>`SELECT ((classid::bigint << 32) | objid::bigint)::text AS key FROM pg_locks WHERE locktype = 'advisory' AND granted`;
  return rows.map((r) => r.key).sort();
});

// Builds a layer in a scope of its own, so the test closes it when it wants to.
const open = async <E>(layer: Layer.Layer<Processors, E, never>) => {
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
  return { processors: Context.get(context, Processors), close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
};

describe("Crablet.processors and Crablet.catalog (ADR-0022)", () => {
  it("runs every module declared when `run` is not given: each takes its own lock and says it leads", { timeout: 30_000 }, async () => {
    const everything = Crablet.modules(Views.module({ views: [], describe: () => "a view" }))
      .with(Automations.module({ automations: [] }))
      .with(Outbox.module({ topics }))
      .with(Deadlines.module({ commands: [] }));
    const running = await open(
      Crablet.processors(everything, { polling, monitorEvery: "1 second" }).pipe(
        Layer.provide(Outbox.publishers(topics, { log: makeLogPublisher() })),
        Layer.provideMerge(base())
      )
    );
    try {
      const deadline = Date.now() + 15_000;
      let status = await Effect.runPromise(running.processors.status);
      while (!status.every((s) => s.leads) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        status = await Effect.runPromise(running.processors.status);
      }
      assert.deepStrictEqual(status, ["views", "automations", "outbox", "deadlines"].map((kind) => ({ kind, runs: true, leads: true })));
      assert.deepStrictEqual(
        await Effect.runPromise(Effect.provide(locksHeld, base())),
        [Views.VIEWS_LOCK_KEY, Automations.AUTOMATIONS_LOCK_KEY, Outbox.OUTBOX_LOCK_KEY, Deadlines.DEADLINES_LOCK_KEY].map(String).sort()
      );
      assert.deepStrictEqual(running.processors.sources.map((s) => s.kind), ["views", "automations", "outbox", "deadlines"]);
    } finally {
      await running.close();
    }
  });


  it("runs the modules in `run` only: the others are built, take no lock, and say so; closing the layer releases the locks", { timeout: 30_000 }, async () => {
    const layer = Crablet.processors(declaration, { run: ["deadlines"], polling }).pipe(
      Layer.provide(Outbox.publishers(topics, { log: makeLogPublisher() })),
      Layer.provideMerge(base())
    );
    const running = await open(layer);
    try {
      const deadline = Date.now() + 10_000;
      let status = await Effect.runPromise(running.processors.status);
      while (!status.some((s) => s.kind === "deadlines" && s.leads) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        status = await Effect.runPromise(running.processors.status);
      }
      assert.deepStrictEqual(status, [
        { kind: "automations", runs: false, leads: false },
        { kind: "outbox", runs: false, leads: false },
        { kind: "deadlines", runs: true, leads: true }
      ]);
      const held = await Effect.runPromise(Effect.provide(locksHeld, base()));
      assert.deepStrictEqual(held, [String(Deadlines.DEADLINES_LOCK_KEY)], "only the module that runs holds its lock");
    } finally {
      await running.close();
    }
    assert.deepStrictEqual(await Effect.runPromise(Effect.provide(locksHeld, base())), [], "closing the layer released the lock");
  });

  it("an outbox given publishers for other names does not start: the start fails naming the missing one", { timeout: 30_000 }, async () => {
    const other = [defineTopic("other-events", { publishers: ["webhook"] })];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Layer.build(Crablet.processors(declaration, { run: ["outbox"], polling }).pipe(Layer.provide(Outbox.publishers(other, { webhook: makeLogPublisher() })), Layer.provide(base())))
      )
    );
    assert.strictEqual(exit._tag, "Failure");
    assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /no publisher given for "log"/);
  });

  it("with roles from the configuration, a kind the declaration has runs, and one it lacks fails the start with UnknownRole before any module is built", { timeout: 30_000 }, async () => {
    const roles = (modules: ReadonlyArray<string>): Crablet.Roles<"api"> => ({ app: new Set(), declared: ["api"], modules });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Layer.build(Crablet.processorsFor(declaration, roles(["deadlines", "views"]), { polling }).pipe(Layer.provide(Outbox.publishers(topics, { log: makeLogPublisher() })), Layer.provide(base()))))
    );
    assert.strictEqual(exit._tag, "Failure");
    assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /UnknownRole.*"views" is not a role of this process; the roles are api, automations, outbox, deadlines, all/s);
    assert.deepStrictEqual(await Effect.runPromise(Effect.provide(locksHeld, base())), [], "nothing was built or started");

    const running = await open(
      Crablet.processorsFor(declaration, roles(["deadlines"]), { polling }).pipe(Layer.provide(Outbox.publishers(topics, { log: makeLogPublisher() })), Layer.provide(base()))
    );
    try {
      const deadline = Date.now() + 10_000;
      let status = await Effect.runPromise(running.processors.status);
      while (!status.some((s) => s.kind === "deadlines" && s.leads) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        status = await Effect.runPromise(running.processors.status);
      }
      assert.deepStrictEqual(status.map((s) => [s.kind, s.runs]), [["automations", false], ["outbox", false], ["deadlines", true]]);
    } finally {
      await running.close();
    }
  });

  it("a catalog and a running process give the same sources; a pause through the catalog is what the running process reads (Liskov)", { timeout: 30_000 }, async () => {
    const catalog = await open(Crablet.catalog(declaration, { polling }).pipe(Layer.provide(base())));
    const running = await open(
      Crablet.processors(declaration, { run: ["outbox"], polling }).pipe(Layer.provide(Outbox.publishers(topics, { log: makeLogPublisher() })), Layer.provide(base()))
    );
    try {
      const idsOf = (p: Processors["Service"]) =>
        Effect.forEach(p.sources, (s) => Effect.map(s.service.getAllStatuses, (statuses) => [s.kind, [...statuses.keys()].sort()] as const));
      assert.deepStrictEqual(await Effect.runPromise(idsOf(catalog.processors)), await Effect.runPromise(idsOf(running.processors)));
      assert.deepStrictEqual(await Effect.runPromise(catalog.processors.status), [
        { kind: "automations", runs: false, leads: false },
        { kind: "outbox", runs: false, leads: false },
        { kind: "deadlines", runs: false, leads: false }
      ]);

      const pair = '["app-test-events","log"]';
      const outboxOf = (p: Processors["Service"]) => p.sources.find((s) => s.kind === "outbox")!.service;
      // the running process registers the pair's progress row when it first polls
      const deadline = Date.now() + 10_000;
      while ((await Effect.runPromiseExit(outboxOf(running.processors).getStatus(pair)))._tag === "Failure" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(await Effect.runPromise(outboxOf(catalog.processors).pause(pair)), true);
      assert.strictEqual(await Effect.runPromise(outboxOf(running.processors).getStatus(pair)), "PAUSED");
      assert.strictEqual(await Effect.runPromise(outboxOf(catalog.processors).resume(pair)), true);
      assert.strictEqual(await Effect.runPromise(outboxOf(running.processors).getStatus(pair)), "ACTIVE");
    } finally {
      await running.close();
      await catalog.close();
    }
  });
});
