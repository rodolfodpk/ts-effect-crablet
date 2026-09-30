// Runs under Node (Testcontainers) - see NOTES.md.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Context, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { HttpRouter, HttpServer } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import { CommandAuditStore, CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { defineCommand, emit, fail } from "@crablet/commands/Command";
import { DomainError } from "@crablet/commands/Errors";
import * as Query from "@crablet/eventstore/Query";
import { makeCommandApiLive } from "../../src/CommandApiLive.ts";
import { exposedCommandOf, type ExposedCommand } from "../../src/ExposedCommand.ts";
import type { CommandApiConfig } from "../../src/CommandApiConfig.ts";

const jsonBody = (res: Response): Promise<Record<string, unknown>> => res.json() as Promise<Record<string, unknown>>;

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<
  CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient,
  never
>;

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
    CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient,
    never
  >;
  runtime = ManagedRuntime.make(layer);
}, { timeout: 60_000 });

after(async () => {
  await runtime.dispose();
  await db.stop();
});

// onDuplicate "fail": opening the same wallet twice is a genuine conflict (409), not a silent no-op.
const OpenWallet = defineCommand({
  name: "open_wallet",
  input: Schema.Struct({ walletId: Schema.String }),
  idempotentBy: (c) => Query.forEventAndTag("WalletOpened", "wallet_id", c.walletId),
  onDuplicate: "fail",
  decide: (_, c) => emit(AppendEvent.of("WalletOpened", "wallet_id", c.walletId, {}))
});

// default onDuplicate: a repeat is an idempotent success (200).
const SendConfirmation = defineCommand({
  name: "send_confirmation",
  input: Schema.Struct({ orderId: Schema.String }),
  idempotentBy: (c) => Query.forEventAndTag("ConfirmationSent", "order_id", c.orderId),
  decide: (_, c) => emit(AppendEvent.of("ConfirmationSent", "order_id", c.orderId, {}))
});

// Domain errors declared with a KIND and no per-command hook: the kind alone decides the HTTP status.
class NoSuchThing extends DomainError("NoSuchThing", { fields: { id: Schema.String }, kind: "not_found" }) {}
class NotAllowed extends DomainError("NotAllowed", { fields: { reason: Schema.String }, kind: "forbidden" }) {}
class BadRequestDomain extends DomainError("BadRequestDomain", { fields: { limit: Schema.Number }, kind: "invalid" }) {}
class AlreadyDone extends DomainError("AlreadyDone", { fields: { id: Schema.String }, kind: "conflict" }) {}

const Refuse = defineCommand({
  name: "refuse",
  input: Schema.Struct({ kind: Schema.Literals(["not_found", "forbidden", "invalid", "conflict"]), id: Schema.String }),
  decide: (_, c) =>
    c.kind === "not_found" ? fail(new NoSuchThing({ id: c.id }))
    : c.kind === "forbidden" ? fail(new NotAllowed({ reason: "read-only" }))
    : c.kind === "invalid" ? fail(new BadRequestDomain({ limit: 10 }))
    : fail(new AlreadyDone({ id: c.id }))
});

const testCommands: Readonly<Record<string, ExposedCommand<any, any>>> = {
  refuse: exposedCommandOf(Refuse),
  open_wallet: exposedCommandOf(OpenWallet),
  send_confirmation: exposedCommandOf(SendConfirmation)
};

// Builds a fresh ephemeral-port HTTP server for the duration of one test (Effect.scoped tears it
// down when `body` finishes), sharing the Postgres-backed ManagedRuntime built once in before().
// Different tests need different CommandApiConfig (basePath/correlationHeaderEnabled), so the
// server itself can't be shared across the whole file the way views/outbox/automations share one
// EventProcessor - only the underlying connection pool is shared.
const withServer = <A>(
  commands: Readonly<Record<string, ExposedCommand<any, any>>>,
  config: CommandApiConfig,
  body: (baseUrl: string) => Promise<A>
): Promise<A> =>
  runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // Layer.provideMerge, not Layer.provide, for the NodeHttpServer piece specifically - same
        // "keep the provided layer's own services in the output too" reasoning ViewsModule.ts/
        // OutboxModule.ts document for SqlClient: HttpApiBuilder.serve()'s own output is `never`
        // (it's a sink, not a service provider), so without provideMerge, HttpServer.HttpServer
        // itself wouldn't survive into the built context below for the address lookup.
        const serverLayer = Layer.provideMerge(
          HttpRouter.serve(makeCommandApiLive(commands, config)),
          NodeHttpServer.layer(createServer, { port: 0 })
        );
        const context = yield* Layer.build(serverLayer);
        const httpServer = Context.get(context, HttpServer.HttpServer);
        const port = httpServer.address._tag === "UnixPathAddress" ? 0 : httpServer.address.port;
        return yield* Effect.promise(() => body(`http://localhost:${port}`));
      })
    )
  );

const getEventRow = (eventType: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ position: string }>("SELECT position FROM crablet_events WHERE type = $1", [
        eventType
      ]);
      return rows[0] ?? null;
    })
  );

describe("commands-http integration (real Postgres)", () => {
  it("happy path: 201 CREATED, event persisted", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const walletId = `wallet-${runId}`;
    await withServer(testCommands, {}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandType: "open_wallet", command: { walletId } })
      });
      assert.strictEqual(res.status, 201);
      const body = await jsonBody(res);
      assert.deepStrictEqual(body, { status: "CREATED", reason: null });
    });

    const row = await getEventRow(`WalletOpened`);
    assert.ok(row !== null, "expected the WalletOpened event to have been persisted");
  });

  it("idempotent duplicate: second call returns 200 IDEMPOTENT with reason", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const orderId = `order-${runId}`;
    await withServer(testCommands, {}, async (baseUrl) => {
      const post = () =>
        fetch(`${baseUrl}/api/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commandType: "send_confirmation", command: { orderId } })
        });

      const first = await post();
      assert.strictEqual(first.status, 201);

      const second = await post();
      assert.strictEqual(second.status, 200);
      const body = await jsonBody(second);
      assert.strictEqual(body.status, "IDEMPOTENT");
      assert.ok(body.reason, "expected a non-empty idempotency reason");
    });
  });

  it("DCB conflict: duplicate open_wallet returns 409 with violationCode/hint", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const walletId = `wallet-conflict-${runId}`;
    await withServer(testCommands, {}, async (baseUrl) => {
      const post = () =>
        fetch(`${baseUrl}/api/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commandType: "open_wallet", command: { walletId } })
        });

      const first = await post();
      assert.strictEqual(first.status, 201);

      const second = await post();
      assert.strictEqual(second.status, 409);
      const body = await jsonBody(second);
      assert.strictEqual(body.status, 409);
      assert.ok(typeof body.violationCode === "string" && body.violationCode.length > 0);
      assert.strictEqual(body.matchingEventsCount, undefined, "the count was dropped from the wire format");
      assert.ok(body.hint);
    });
  });

  it("unknown commandType returns 400", { timeout: 20_000 }, async () => {
    await withServer(testCommands, {}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandType: "does_not_exist", command: {} })
      });
      assert.strictEqual(res.status, 400);
      const body = await jsonBody(res);
      assert.strictEqual(body.status, 400);
    });
  });

  it("malformed JSON body is rejected with a 4xx status", { timeout: 20_000 }, async () => {
    await withServer(testCommands, {}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not valid json"
      });
      assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx status, got ${res.status}`);
    });
  });

  it("GET lists the exposed command types", { timeout: 20_000 }, async () => {
    await withServer(testCommands, {}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/commands`);
      assert.strictEqual(res.status, 200);
      const body = await jsonBody(res);
      assert.deepStrictEqual(body, {
        exposedCommands: [{ commandType: "open_wallet" }, { commandType: "refuse" }, { commandType: "send_confirmation" }]
      });
    });
  });

  it("custom basePath relocates both routes", { timeout: 20_000 }, async () => {
    await withServer(testCommands, { basePath: "/api/custom-commands" }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/custom-commands`);
      assert.strictEqual(res.status, 200);
    });
  });

  describe("correlation header (correlationHeaderEnabled: true)", () => {
    it("a supplied correlation id is echoed back", { timeout: 20_000 }, async () => {
      const correlationId = crypto.randomUUID();
      await withServer(testCommands, { correlationHeaderEnabled: true }, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Correlation-Id": correlationId },
          body: JSON.stringify({ commandType: "open_wallet", command: { walletId: crypto.randomUUID() } })
        });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.headers.get("x-correlation-id"), correlationId);
      });
    });

    it("a missing correlation id is generated and echoed", { timeout: 20_000 }, async () => {
      await withServer(testCommands, { correlationHeaderEnabled: true }, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commandType: "open_wallet", command: { walletId: crypto.randomUUID() } })
        });
        assert.strictEqual(res.status, 201);
        assert.ok(res.headers.get("x-correlation-id"), "expected a generated correlation id to be echoed");
      });
    });

    it("a malformed correlation id is rejected with 400", { timeout: 20_000 }, async () => {
      await withServer(testCommands, { correlationHeaderEnabled: true }, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Correlation-Id": "not-a-uuid" },
          body: JSON.stringify({ commandType: "open_wallet", command: { walletId: crypto.randomUUID() } })
        });
        assert.strictEqual(res.status, 400);
      });
    });

    it("when disabled, an inbound correlation id is ignored (not echoed)", { timeout: 20_000 }, async () => {
      await withServer(testCommands, { correlationHeaderEnabled: false }, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Correlation-Id": crypto.randomUUID() },
          body: JSON.stringify({ commandType: "open_wallet", command: { walletId: crypto.randomUUID() } })
        });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.headers.get("x-correlation-id"), null);
      });
    });
  });
});

describe("a domain error's kind decides the HTTP status (no per-command hook)", () => {
  const post = (baseUrl: string, kind: string, id = "x1") =>
    fetch(`${baseUrl}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandType: "refuse", command: { kind, id } })
    });

  for (const [kind, status, title, errorType, fields] of [
    ["not_found", 404, "Not Found", "NoSuchThing", { id: "x1" }],
    ["forbidden", 403, "Forbidden", "NotAllowed", { reason: "read-only" }],
    ["invalid", 400, "Bad Request", "BadRequestDomain", { limit: 10 }],
    ["conflict", 409, "Conflict", "AlreadyDone", { id: "x1" }]
  ] as const) {
    it(`${kind} -> ${status}, with the error's tag and fields as RFC 7807 extension members`, async () => {
      await withServer(testCommands, {}, async (baseUrl) => {
        const res = await post(baseUrl, kind);
        assert.strictEqual(res.status, status);
        const body = await jsonBody(res);
        assert.strictEqual(body.status, status);
        assert.strictEqual(body.title, title);
        assert.strictEqual(body.errorType, errorType);
        assert.deepStrictEqual(body.fields, fields);
        assert.match(String(body.type), /^urn:crablet:problem:command-api:/);
        assert.strictEqual(body.detail, errorType, "no message on the error, so the tag is the detail");
        assert.strictEqual(body._tag, undefined, "no internal _tag leaks into the body");
      });
    });
  }
});
