// Runs under Node (Testcontainers). A command whose lookup reads every event (`Query.all()`, ADR-0050): the whole log is in its condition, so any event
// appended between its read and its append refuses the append, and the command is decided again. Proof that `Query.all()` reaches the condition
// through the union of what the command read (Query.union) and is not mistaken for a lookup that does not overlap what the command appends.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Fiber, Metric, Redacted, Schema } from "effect";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore } from "@crablet/eventstore";
import * as Query from "@crablet/eventstore/Query";
import * as CommandMetrics from "@crablet/metrics-otel/CommandMetrics";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { defineCommand, emit } from "../../src/Command.ts";
import { defineEvent } from "../../src/Event.ts";
import { pause } from "../support/barrier.ts";

let db: TestDb;
before(async () => { db = await startTestDb(); }, { timeout: 60_000 });
after(async () => { await db.stop(); });

const AppLive = () =>
  Crablet.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.provide(e, AppLive()) as Effect.Effect<A, E, never>);

const Counted = defineEvent("LogCounted", { schema: Schema.Struct({ id: Schema.String, empty: Schema.Boolean }), tags: (d) => ({ count_id: d.id }) });
const Unrelated = defineEvent("SomethingElse", { schema: Schema.Struct({ id: Schema.String }), tags: (d) => ({ other_id: d.id }) });

describe("a command whose lookup reads every event", () => {
  it("any event appended between its read and its append is a conflict: the command is decided again", { timeout: 60_000 }, async () => {
    const id = crypto.randomUUID();
    const outcome = await run(
      Effect.gen(function* () {
        const p = yield* pause;
        const CountLog = defineCommand({
          name: "count_log",
          input: Schema.Struct({ id: Schema.String }),
          resolve: (_c, read) => Effect.tap(read.exists(Query.all()), () => p.wait),
          decide: (_s, c, { resolved }) => emit(Counted({ id: c.id, empty: !resolved }))
        });
        const before = (yield* Metric.value(Metric.withAttributes(CommandMetrics.conflictRetries, { command_type: "count_log" }))).count;
        const fiber = yield* Effect.forkChild(Effect.exit((yield* CommandExecutor).run(CountLog, { id })));
        yield* p.loaded;
        yield* (yield* EventStore).append([Unrelated({ id })]); // not in any tag or type the command names: only `Query.all()` covers it
        yield* p.resume;
        const exit = yield* Fiber.join(fiber);
        const retries = (yield* Metric.value(Metric.withAttributes(CommandMetrics.conflictRetries, { command_type: "count_log" }))).count - before;
        return { exit, retries };
      })
    );
    assert.strictEqual(outcome.exit._tag, "Success");
    assert.ok(outcome.retries >= 1, `the append was not refused (retries: ${outcome.retries}): Query.all() did not reach the condition`);
  });
});
