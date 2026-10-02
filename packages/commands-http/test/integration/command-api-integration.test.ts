// Runs under Node (Testcontainers) - see NOTES.md.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Context, Duration, Effect, Layer, ManagedRuntime, Redacted } from "effect";
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
import type { ViewWaiter } from "../../src/ViewWaiter.ts";

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
  errors: [NoSuchThing, NotAllowed, BadRequestDomain, AlreadyDone],
  input: Schema.Struct({ kind: Schema.Literals(["not_found", "forbidden", "invalid", "conflict"]), id: Schema.String }),
  decide: (_, c) =>
    c.kind === "not_found" ? fail(new NoSuchThing({ id: c.id }))
    : c.kind === "forbidden" ? fail(new NotAllowed({ reason: "read-only" }))
    : c.kind === "invalid" ? fail(new BadRequestDomain({ limit: 10 }))
    : fail(new AlreadyDone({ id: c.id }))
});

const testCommands = {
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
      const res = await fetch(`${baseUrl}/api/commands/open_wallet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletId })
      });
      assert.strictEqual(res.status, 201);
      const body = await jsonBody(res);
      assert.strictEqual(body.status, "CREATED");
      assert.strictEqual(body.reason, null);
      assert.match(String(body.lastPosition), /^\d+$/, "the position of the last appended event, as a string");
    });

    const row = await getEventRow(`WalletOpened`);
    assert.ok(row !== null, "expected the WalletOpened event to have been persisted");
  });

  it("idempotent duplicate: second call returns 200 IDEMPOTENT with reason", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const orderId = `order-${runId}`;
    await withServer(testCommands, {}, async (baseUrl) => {
      const post = () =>
        fetch(`${baseUrl}/api/commands/send_confirmation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId })
        });

      const first = await post();
      assert.strictEqual(first.status, 201);

      const second = await post();
      assert.strictEqual(second.status, 200);
      const body = await jsonBody(second);
      assert.strictEqual(body.status, "IDEMPOTENT");
      assert.ok(body.reason, "expected a non-empty idempotency reason");
      assert.strictEqual(body.lastPosition, null, "a repeat appended nothing");
    });
  });

  it("DCB conflict: duplicate open_wallet returns 409 with violationCode/hint", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const walletId = `wallet-conflict-${runId}`;
    await withServer(testCommands, {}, async (baseUrl) => {
      const post = () =>
        fetch(`${baseUrl}/api/commands/open_wallet`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletId })
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

  it("an unknown command has no route: 404", { timeout: 20_000 }, async () => {
    await withServer(testCommands, {}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/commands/does_not_exist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      assert.strictEqual(res.status, 404);
    });
  });

  it("a payload that does not match the command's input is a 400 problem naming the command", { timeout: 20_000 }, async () => {
    await withServer(testCommands, {}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/commands/open_wallet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletId: 42 })
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.headers.get("content-type"), "application/problem+json");
      const body = await jsonBody(res);
      assert.strictEqual(body.status, 400);
      assert.strictEqual(body.detail, "Invalid payload for command: open_wallet");
      // and says WHICH field, by path, without echoing the value that was sent
      assert.deepStrictEqual(body["errors"], [{ path: ["walletId"], message: "Expected string" }]);
    });
  });

  it("a malformed JSON body gets the same 400 problem (not an empty-bodied default)", { timeout: 20_000 }, async () => {
    await withServer(testCommands, {}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/commands/open_wallet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not valid json"
      });
      assert.strictEqual(res.status, 400);
      const body = await jsonBody(res);
      assert.strictEqual(body.detail, "Invalid payload for command: open_wallet");
      assert.ok(!("errors" in body), "a body that is not JSON has no fields to blame");
    });
  });

  it("GET lists the exposed commands, each with its input as JSON Schema", { timeout: 20_000 }, async () => {
    await withServer(testCommands, {}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/commands`);
      assert.strictEqual(res.status, 200);
      const body = (await jsonBody(res)) as { exposedCommands: Array<{ commandType: string; inputSchema: any }> };
      assert.deepStrictEqual(body.exposedCommands.map((c) => c.commandType), ["open_wallet", "refuse", "send_confirmation"]);
      const openWallet = body.exposedCommands.find((c) => c.commandType === "open_wallet")!;
      assert.deepStrictEqual(openWallet.inputSchema.schema.required, ["walletId"]);
      assert.strictEqual(openWallet.inputSchema.schema.properties.walletId.type, "string");
    });
  });

  it("custom basePath relocates both routes", { timeout: 20_000 }, async () => {
    await withServer(testCommands, { basePath: "/api/custom-commands" }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/custom-commands`);
      assert.strictEqual(res.status, 200);
    });
  });

  describe("the API description", () => {
    it("OpenAPI document is served at /openapi.json by default, describing every command route", { timeout: 20_000 }, async () => {
      await withServer(testCommands, {}, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/openapi.json`);
        assert.strictEqual(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /application\/json/);
        const spec = (await res.json()) as any;
        assert.strictEqual(spec.openapi, "3.1.0");
        assert.strictEqual(spec.info.title, "Command API");
        assert.deepStrictEqual(Object.keys(spec.paths).sort(), [
          "/api/commands",
          "/api/commands/open_wallet",
          "/api/commands/refuse",
          "/api/commands/send_confirmation"
        ]);
        // the four declared domain errors of `refuse`, each at the status of its kind
        assert.deepStrictEqual(
          Object.keys(spec.paths["/api/commands/refuse"].post.responses).sort(),
          ["200", "201", "400", "403", "404", "409", "500"]
        );
      });
    });

    it("the document can be moved or turned off", { timeout: 20_000 }, async () => {
      await withServer(testCommands, { openApiPath: "/api/spec.json" }, async (baseUrl) => {
        assert.strictEqual((await fetch(`${baseUrl}/api/spec.json`)).status, 200);
        assert.strictEqual((await fetch(`${baseUrl}/openapi.json`)).status, 404);
      });
      await withServer(testCommands, { openApiPath: false }, async (baseUrl) => {
        assert.strictEqual((await fetch(`${baseUrl}/openapi.json`)).status, 404);
      });
    });

    it("no documentation page unless asked for; Scalar and Swagger UI when configured", { timeout: 30_000 }, async () => {
      await withServer(testCommands, {}, async (baseUrl) => {
        assert.strictEqual((await fetch(`${baseUrl}/docs`)).status, 404);
      });
      for (const ui of ["scalar", "swagger"] as const) {
        await withServer(testCommands, { docs: { ui } }, async (baseUrl) => {
          const res = await fetch(`${baseUrl}/docs`);
          assert.strictEqual(res.status, 200, `${ui} page`);
          assert.match(res.headers.get("content-type") ?? "", /text\/html/);
        });
      }
      await withServer(testCommands, { docs: { ui: "scalar", path: "/reference" } }, async (baseUrl) => {
        assert.strictEqual((await fetch(`${baseUrl}/reference`)).status, 200);
      });
    });
  });

  describe("read your own writes: ?waitFor=<view>", () => {
    const waits: Array<{ view: string; position: bigint; timeoutMs: number; committed: boolean }> = [];

    // Fake waiters (this package never imports the views package). `ok` also checks, from inside the wait, that the
    // command's events are already committed and visible - the order a real view wait relies on.
    const record = (view: string): ViewWaiter => ({ position }, { timeout }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql.unsafe<{ position: string }>("SELECT position::text AS position FROM crablet_events WHERE position = $1", [position.toString()]);
        waits.push({ view, position, timeoutMs: Duration.toMillis(timeout), committed: rows.length === 1 });
      });
    const viewWaiters: Record<string, ViewWaiter> = {
      ok: record("ok"),
      slow: () => Effect.fail({ _tag: "WaitTimeout", reached: 0n } as const),
      failed: () => Effect.fail({ _tag: "ViewFailed" } as const),
      broken: () => Effect.fail({ _tag: "SqlError" } as never)
    };
    const open = (baseUrl: string, query: string, walletId: string = crypto.randomUUID()) =>
      fetch(`${baseUrl}/api/commands/open_wallet${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletId })
      });

    it("waits for the view after the command is committed, and reports that it caught up", { timeout: 20_000 }, async () => {
      waits.length = 0;
      await withServer(testCommands, { viewWaiters }, async (baseUrl) => {
        const res = await open(baseUrl, "?waitFor=ok");
        assert.strictEqual(res.status, 201);
        const body = await jsonBody(res);
        assert.deepStrictEqual(body.view, { name: "ok", caughtUp: true });
        assert.strictEqual(waits.length, 1);
        assert.strictEqual(waits[0]!.position, BigInt(String(body.lastPosition)), "waited for the position the response reports");
        assert.strictEqual(waits[0]!.committed, true, "the command's events were committed before the wait began");
        assert.strictEqual(waits[0]!.timeoutMs, 5000, "default wait timeout");
      });
    });

    it("waitTimeout is passed on", { timeout: 20_000 }, async () => {
      waits.length = 0;
      await withServer(testCommands, { viewWaiters }, async (baseUrl) => {
        assert.strictEqual((await open(baseUrl, "?waitFor=ok&waitTimeout=1234")).status, 201);
        assert.strictEqual(waits[0]!.timeoutMs, 1234);
      });
    });

    it("a view that did not catch up is reported in the body; the write is still a success (never an error status)", { timeout: 20_000 }, async () => {
      await withServer(testCommands, { viewWaiters }, async (baseUrl) => {
        for (const [view, reason] of [["slow", "timeout"], ["failed", "view_failed"], ["broken", "unavailable"]] as const) {
          const res = await open(baseUrl, `?waitFor=${view}`);
          assert.strictEqual(res.status, 201, view);
          assert.deepStrictEqual((await jsonBody(res)).view, { name: view, caughtUp: false, reason });
        }
      });
    });

    it("an idempotent repeat appended nothing: there is nothing to wait for, and the waiter is not called", { timeout: 20_000 }, async () => {
      waits.length = 0;
      const orderId = `order-${crypto.randomUUID()}`;
      await withServer(testCommands, { viewWaiters }, async (baseUrl) => {
        const confirm = () =>
          fetch(`${baseUrl}/api/commands/send_confirmation?waitFor=ok`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderId })
          });
        assert.strictEqual((await confirm()).status, 201);
        assert.strictEqual(waits.length, 1);
        const repeat = await confirm();
        assert.strictEqual(repeat.status, 200);
        assert.deepStrictEqual((await jsonBody(repeat)).view, { name: "ok", caughtUp: false, reason: "nothing_appended" });
        assert.strictEqual(waits.length, 1, "no second wait");
      });
    });

    it("without the parameters the response has no `view`", { timeout: 20_000 }, async () => {
      await withServer(testCommands, { viewWaiters }, async (baseUrl) => {
        assert.strictEqual("view" in (await jsonBody(await open(baseUrl, ""))), false);
      });
    });

    it("bad parameters are a 400 BEFORE the command runs: nothing is written", { timeout: 20_000 }, async () => {
      await withServer(testCommands, { viewWaiters }, async (baseUrl) => {
        for (const query of ["?waitFor=nope", "?waitTimeout=500", "?waitFor=ok&waitTimeout=0", "?waitFor=ok&waitTimeout=99999", "?waitFor=ok&waitTimeout=abc"]) {
          const walletId = `wallet-${crypto.randomUUID()}`;
          const res = await open(baseUrl, query, walletId);
          assert.strictEqual(res.status, 400, query);
          assert.strictEqual(res.headers.get("content-type"), "application/problem+json");
          const written = await runtime.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql.unsafe<{ position: string }>("SELECT position::text AS position FROM crablet_events WHERE tags @> $1::text[]", [[`wallet_id=${walletId}`]]);
            })
          );
          assert.strictEqual(written.length, 0, `${query}: the command must not have run`);
        }
        const unknown = await jsonBody(await open(baseUrl, "?waitFor=nope"));
        assert.match(String(unknown.detail), /one of: ok, slow, failed, broken/);
      });
    });

    it("with no views configured, waitFor is refused and says so", { timeout: 20_000 }, async () => {
      await withServer(testCommands, {}, async (baseUrl) => {
        const res = await open(baseUrl, "?waitFor=ok");
        assert.strictEqual(res.status, 400);
        assert.match(String((await jsonBody(res)).detail), /no views can be waited for/);
      });
    });
  });

  describe("correlation header (correlationHeaderEnabled: true)", () => {
    it("a supplied correlation id is echoed back", { timeout: 20_000 }, async () => {
      const correlationId = crypto.randomUUID();
      await withServer(testCommands, { correlationHeaderEnabled: true }, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/commands/open_wallet`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Correlation-Id": correlationId },
          body: JSON.stringify({ walletId: crypto.randomUUID() })
        });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.headers.get("x-correlation-id"), correlationId);
      });
    });

    it("a missing correlation id is generated and echoed", { timeout: 20_000 }, async () => {
      await withServer(testCommands, { correlationHeaderEnabled: true }, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/commands/open_wallet`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletId: crypto.randomUUID() })
        });
        assert.strictEqual(res.status, 201);
        assert.ok(res.headers.get("x-correlation-id"), "expected a generated correlation id to be echoed");
      });
    });

    it("a malformed correlation id is rejected with 400", { timeout: 20_000 }, async () => {
      await withServer(testCommands, { correlationHeaderEnabled: true }, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/commands/open_wallet`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Correlation-Id": "not-a-uuid" },
          body: JSON.stringify({ walletId: crypto.randomUUID() })
        });
        assert.strictEqual(res.status, 400);
      });
    });

    it("when disabled, an inbound correlation id is ignored (not echoed)", { timeout: 20_000 }, async () => {
      await withServer(testCommands, { correlationHeaderEnabled: false }, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/commands/open_wallet`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Correlation-Id": crypto.randomUUID() },
          body: JSON.stringify({ walletId: crypto.randomUUID() })
        });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.headers.get("x-correlation-id"), null);
      });
    });
  });
});

describe("a domain error's kind decides the HTTP status (no per-command hook)", () => {
  const post = (baseUrl: string, kind: string, id = "x1") =>
    fetch(`${baseUrl}/api/commands/refuse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, id })
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
