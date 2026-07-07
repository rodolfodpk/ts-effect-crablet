// Runs under Node (Testcontainers) - see NOTES.md.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive, existsProjector } from "@crablet/eventstore";
import { CommandAuditStore, CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { ConcurrencyException } from "@crablet/eventstore/DCBViolation";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import * as Query from "@crablet/eventstore/Query";
import * as StreamPosition from "@crablet/eventstore/StreamPosition";
import { CommandExecutor, CommandExecutorLive, type CommandHandler } from "../src/CommandExecutor.ts";
import * as CD from "../src/CommandDecision.ts";

let db: TestDb;
let layer: Layer.Layer<CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  const appLayers = Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive);
  layer = Layer.provideMerge(appLayers, pgLayer) as unknown as Layer.Layer<
    CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient,
    never
  >;
}, { timeout: 60_000 });

after(async () => {
  await db.stop();
});

const run = <A, E>(
  effect: Effect.Effect<A, E, CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient>
) => Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

interface TestCommand {
  readonly entityId: string;
}

describe("CommandExecutor (Phase 1)", () => {
  it("Commutative decision: appends successfully", async () => {
    const entityId = crypto.randomUUID();
    const handler: CommandHandler<TestCommand> = (cmd) =>
      Effect.succeed(CD.commutative(AppendEvent.of("TestEvent", "entity_id", cmd.entityId, {})));

    const result = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        return yield* executor.execute("TestCommand", { entityId }, handler);
      })
    );

    assert.strictEqual(result.wasIdempotent, false);
  });

  it("CommutativeGuarded: staggered lifecycle event before append throws GUARD_VIOLATION", async () => {
    const entityId = crypto.randomUUID();
    const lifecycleQuery = Query.forEventAndTag("entity_closed", "entity_id", entityId);

    const guardPosition = await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        const projection = yield* store.project(lifecycleQuery, StreamPosition.zero(), [existsProjector()]);
        return projection.streamPosition;
      })
    );

    // Staggered: the lifecycle event fully commits before the guarded append runs.
    await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.appendCommutative([AppendEvent.of("entity_closed", "entity_id", entityId, {})]);
      })
    );

    const handler: CommandHandler<TestCommand> = (cmd) =>
      Effect.succeed(
        CD.withLifecycleGuard(AppendEvent.of("TestEvent", "entity_id", cmd.entityId, {}), lifecycleQuery, guardPosition)
      );

    const outcome = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        return yield* executor.execute("TestCommand", { entityId }, handler).pipe(
          Effect.map(() => "success" as const),
          Effect.catchTag("ConcurrencyException", (e) => Effect.succeed(e))
        );
      })
    );

    assert.ok(outcome instanceof ConcurrencyException, `expected ConcurrencyException, got ${JSON.stringify(outcome)}`);
    assert.strictEqual(outcome.violation?.errorCode, "GUARD_VIOLATION");
  });

  it("CommutativeGuarded: idempotent retry after lifecycle change returns idempotent, not GUARD_VIOLATION", async () => {
    const entityId = crypto.randomUUID();
    const lifecycleQuery = Query.forEventAndTag("entity_closed", "entity_id", entityId);
    const opId = crypto.randomUUID();

    const guardPosition = await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        const projection = yield* store.project(lifecycleQuery, StreamPosition.zero(), [existsProjector()]);
        return projection.streamPosition;
      })
    );

    const handler: CommandHandler<TestCommand> = (cmd) =>
      Effect.succeed(
        CD.commutativeGuardedIdempotent(
          CD.withLifecycleGuard(
            AppendEvent.builder("TestEvent").tag("entity_id", cmd.entityId).tag("op_id", opId).data({}).build(),
            lifecycleQuery,
            guardPosition
          ),
          "TestEvent",
          "op_id",
          opId
        )
      );

    const first = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        return yield* executor.execute("TestCommand", { entityId }, handler);
      })
    );
    assert.strictEqual(first.wasIdempotent, false);

    // The lifecycle change commits after the first successful execution.
    await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.appendCommutative([AppendEvent.of("entity_closed", "entity_id", entityId, {})]);
      })
    );

    // Retry with the same stale guardPosition and idempotency key - should return idempotent,
    // not throw GUARD_VIOLATION, since idempotency is checked before concurrency.
    const retry = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        return yield* executor.execute("TestCommand", { entityId }, handler);
      })
    );
    assert.strictEqual(retry.wasIdempotent, true);
  });

  it("Idempotent with THROW policy: duplicate throws ConcurrencyException", async () => {
    const entityId = crypto.randomUUID();
    const handler: CommandHandler<TestCommand> = (cmd) =>
      Effect.succeed(
        CD.idempotent(AppendEvent.of("EntityCreated", "entity_id", cmd.entityId, {}), "EntityCreated", "entity_id", cmd.entityId, "THROW")
      );

    const first = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        return yield* executor.execute("TestCommand", { entityId }, handler);
      })
    );
    assert.strictEqual(first.wasIdempotent, false);

    const second = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        return yield* executor.execute("TestCommand", { entityId }, handler).pipe(
          Effect.map(() => "success" as const),
          Effect.catchTag("ConcurrencyException", (e) => Effect.succeed(e))
        );
      })
    );
    assert.ok(second instanceof ConcurrencyException);
  });
});
