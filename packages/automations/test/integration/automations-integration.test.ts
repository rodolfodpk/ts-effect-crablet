// Runs under Node (Testcontainers) - see NOTES.md.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStore, CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import * as Schema from "effect/Schema";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { defineCommand, emit, noop } from "@crablet/commands/Command";
import { defineEvent } from "@crablet/commands/Event";
import { makeAutomationsProcessor } from "../../src/AutomationsModule.ts";
import { automationHandlerOf } from "../../src/AutomationHandler.ts";
import { executeCommand, noOp } from "../../src/AutomationDecision.ts";
import type { AutomationsConfig } from "../../src/AutomationsConfig.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<
  CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient | PgClient.PgClient,
  never
>;

// ManagedRuntime, not plain Layer + Effect.provide - makeAutomationsProcessor()'s
// handle.service.start forks long-lived daemon fibers that must keep using the same connection
// pool across many separate run() calls in one test, same as views-integration.test.ts.
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
  const layer = Layer.provideMerge(appLayers, pgLayer) as unknown as Layer.Layer<
    CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient | PgClient.PgClient,
    never
  >;
  runtime = ManagedRuntime.make(layer);
}, { timeout: 60_000 });

after(async () => {
  await runtime.dispose();
  await db.stop();
});

const run = <A, E>(
  effect: Effect.Effect<A, E, CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient | PgClient.PgClient>
) => runtime.runPromise(effect);

const waitUntilAsync = async <A>(check: () => Promise<A>, predicate: (a: A) => boolean, timeoutMs = 10_000) => {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const getProgress = (automationName: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ last_position: string; status: string; error_count: number }>(
        "SELECT last_position::text AS last_position, status, error_count FROM crablet_automation_progress WHERE automation_name = $1",
        [automationName]
      );
      return rows[0] ?? null;
    })
  );

const getEventRow = (eventType: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{
        position: string;
        correlation_id: string | null;
        causation_id: string | null;
      }>("SELECT position::text AS position, correlation_id, causation_id::text AS causation_id FROM crablet_events WHERE type = $1", [eventType]);
      return rows[0] ?? null;
    })
  );

const baseAutomationsConfig: AutomationsConfig = {
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

describe("automations module integration (real Postgres)", () => {
  it("trigger event -> decide -> real CommandExecutor -> resulting event, with progress + correlation/causation propagation", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const automationName = `send-confirmation-${runId}`;
    const triggerType = `OrderPlaced-${runId}`;
    const confirmationType = `ConfirmationSent-${runId}`;
    const orderId = `order-${runId}`;
    const triggerCorrelationId = crypto.randomUUID();

    const ConfirmationSent = defineEvent(confirmationType, {
      schema: Schema.Struct({ orderId: Schema.String }),
      tags: (d) => ({ order_id: d.orderId })
    });
    const sendConfirmation = defineCommand({
      name: "SendConfirmationCommand",
      input: Schema.Struct({ orderId: Schema.String }),
      decide: (_, c) => emit(ConfirmationSent(c))
    });

    const automation = automationHandlerOf(
      automationName,
      sendConfirmation,
      (event) =>
        Effect.succeed([
          executeCommand({
            orderId: event.tags.find((t) => t.key === "order_id")!.value
          })
        ]),
      { eventTypes: new Set([triggerType]) }
    );

    const handle = await run(
      makeAutomationsProcessor({
        config: baseAutomationsConfig,
        handlers: [automation],
        instanceId: `instance-${crypto.randomUUID()}`
      })
    );

    try {
      await run(handle.service.start);

      await run(
        CorrelationContext.withCorrelationId(triggerCorrelationId)(
          Effect.gen(function* () {
            const store = yield* EventStore;
            yield* store.append([AppendEvent.of(triggerType, "order_id", orderId, {})]);
          })
        )
      );

      const progress = await waitUntilAsync(
        () => getProgress(automationName),
        (p) => p !== null && p.last_position !== "0"
      );

      const triggerRow = await getEventRow(triggerType);
      assert.ok(triggerRow !== null, "expected the trigger event to have been appended");
      assert.strictEqual(progress!.last_position, triggerRow!.position, "progress should advance to the trigger event's position");

      const confirmationRow = await waitUntilAsync(() => getEventRow(confirmationType), (row) => row !== null);
      assert.ok(confirmationRow !== null, "expected the automation-issued command to append a resulting event");
      assert.strictEqual(
        confirmationRow!.correlation_id,
        triggerCorrelationId,
        "resulting event should inherit the trigger event's correlation id"
      );
      assert.strictEqual(
        confirmationRow!.causation_id,
        triggerRow!.position,
        "resulting event's causation id should be the trigger event's own position"
      );
    } finally {
      await run(handle.service.stop);
    }
  });

  it("a NoOp decision advances progress without appending any resulting event", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const automationName = `noop-automation-${runId}`;
    const triggerType = `NoopTrigger-${runId}`;

    const noopCommand = defineCommand({ name: "NoopCommand", input: Schema.Unknown, decide: () => noop() });
    const automation = automationHandlerOf(automationName, noopCommand, () => Effect.succeed([noOp()]), {
      eventTypes: new Set([triggerType])
    });

    const handle = await run(
      makeAutomationsProcessor({
        config: baseAutomationsConfig,
        handlers: [automation],
        instanceId: `instance-${crypto.randomUUID()}`
      })
    );

    try {
      await run(handle.service.start);

      await run(
        Effect.gen(function* () {
          const store = yield* EventStore;
          yield* store.append([AppendEvent.ofUntagged(triggerType, {})]);
        })
      );

      const progress = await waitUntilAsync(
        () => getProgress(automationName),
        (p) => p !== null && p.last_position !== "0"
      );
      assert.ok(progress !== null && progress.last_position !== "0", "expected progress to advance past the NoOp'd trigger event");
      assert.strictEqual(progress!.error_count, 0);
    } finally {
      await run(handle.service.stop);
    }
  });
});
