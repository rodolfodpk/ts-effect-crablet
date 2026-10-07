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
import { parseMarker } from "@crablet/eventstore/Marker";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { defineCommand, emit, fail } from "@crablet/commands/Command";
import { defineEvent } from "@crablet/commands/Event";
import { defineModel } from "@crablet/commands/Model";
import { DomainError } from "@crablet/commands/Errors";
import { commandContract } from "@crablet/commands/Contract";
import * as Query from "@crablet/eventstore/Query";
import { makeCommandApiLive } from "../../src/CommandApiLive.ts";
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
const OpenWalletContract = commandContract({ name: "open_wallet", input: Schema.Struct({ walletId: Schema.String }) });
const OpenWallet = defineCommand({
  ...OpenWalletContract,
  idempotentBy: (c) => Query.forEventAndTag("WalletOpened", "wallet_id", c.walletId),
  onDuplicate: "fail",
  decide: (_, c) => emit(AppendEvent.of("WalletOpened", "wallet_id", c.walletId, {}))
});

// default onDuplicate: a repeat is an idempotent success (200).
const SendConfirmationContract = commandContract({ name: "send_confirmation", input: Schema.Struct({ orderId: Schema.String }) });
const SendConfirmation = defineCommand({
  ...SendConfirmationContract,
  idempotentBy: (c) => Query.forEventAndTag("ConfirmationSent", "order_id", c.orderId),
  decide: (_, c) => emit(AppendEvent.of("ConfirmationSent", "order_id", c.orderId, {}))
});

// Domain errors declared with a KIND and no per-command hook: the kind alone decides the HTTP status.
class NoSuchThing extends DomainError("NoSuchThing", { fields: { id: Schema.String }, kind: "not_found" }) {}
class NotAllowed extends DomainError("NotAllowed", { fields: { reason: Schema.String }, kind: "forbidden" }) {}
class BadRequestDomain extends DomainError("BadRequestDomain", { fields: { limit: Schema.Number }, kind: "invalid" }) {}
class AlreadyDone extends DomainError("AlreadyDone", { fields: { id: Schema.String }, kind: "conflict" }) {}

const RefuseContract = commandContract({
  name: "refuse",
  errors: [NoSuchThing, NotAllowed, BadRequestDomain, AlreadyDone],
  input: Schema.Struct({ kind: Schema.Literals(["not_found", "forbidden", "invalid", "conflict"]), id: Schema.String })
});
const Refuse = defineCommand({
  ...RefuseContract,
  decide: (_, c) =>
    c.kind === "not_found" ? fail(new NoSuchThing({ id: c.id }))
    : c.kind === "forbidden" ? fail(new NotAllowed({ reason: "read-only" }))
    : c.kind === "invalid" ? fail(new BadRequestDomain({ limit: 10 }))
    : fail(new AlreadyDone({ id: c.id }))
});

// The API is declared from the commands' CONTRACTS (routes, request bodies and problems come from them alone); the server is handed the
// implementations, checked against the contracts when the layer is built.
const contracts = [RefuseContract, OpenWalletContract, SendConfirmationContract];
const implementations = { refuse: Refuse, open_wallet: OpenWallet, send_confirmation: SendConfirmation };

// Builds a fresh ephemeral-port HTTP server for the duration of one test (Effect.scoped tears it
// down when `body` finishes), sharing the Postgres-backed ManagedRuntime built once in before().
// Different tests need different CommandApiConfig (basePath/correlationHeaderEnabled), so the
// server itself can't be shared across the whole file the way views/outbox/automations share one
// EventProcessor - only the underlying connection pool is shared.
const withServer = <A>(config: CommandApiConfig, body: (baseUrl: string) => Promise<A>): Promise<A> =>
  serve(makeCommandApiLive(contracts, implementations, config), body);

const serve = <A>(live: ReturnType<typeof makeCommandApiLive<typeof contracts>>, body: (baseUrl: string) => Promise<A>): Promise<A> =>
  runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // Layer.provideMerge, not Layer.provide, for the NodeHttpServer piece specifically - same
        // "keep the provided layer's own services in the output too" reasoning ViewsModule.ts/
        // OutboxModule.ts document for SqlClient: HttpApiBuilder.serve()'s own output is `never`
        // (it's a sink, not a service provider), so without provideMerge, HttpServer.HttpServer
        // itself wouldn't survive into the built context below for the address lookup.
        const serverLayer = Layer.provideMerge(
          HttpRouter.serve(live),
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
    await withServer({}, async (baseUrl) => {
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
      assert.match(String(body.lastTransactionId), /^\d+$/, "the transaction that wrote it, as a string");
      assert.strictEqual(body.marker, `${body.lastTransactionId}:${body.lastPosition}`, "the write's marker: transaction id and position");
      assert.deepStrictEqual(parseMarker(String(body.marker)), { transactionId: String(body.lastTransactionId), position: BigInt(String(body.lastPosition)) });
    });

    const row = await getEventRow(`WalletOpened`);
    assert.ok(row !== null, "expected the WalletOpened event to have been persisted");
  });

  it("idempotent duplicate: second call returns 200 IDEMPOTENT with reason", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const orderId = `order-${runId}`;
    await withServer({}, async (baseUrl) => {
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
      assert.strictEqual(body.lastTransactionId, null);
      assert.strictEqual(body.marker, null, "a repeat appended nothing, so it has no marker (yet)");
    });
  });

  it("DCB conflict: duplicate open_wallet returns 409 with violationCode/hint", { timeout: 20_000 }, async () => {
    const runId = crypto.randomUUID();
    const walletId = `wallet-conflict-${runId}`;
    await withServer({}, async (baseUrl) => {
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
    await withServer({}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/commands/does_not_exist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      assert.strictEqual(res.status, 404);
    });
  });

  it("a payload that does not match the command's input is a 400 problem naming the command", { timeout: 20_000 }, async () => {
    await withServer({}, async (baseUrl) => {
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
    await withServer({}, async (baseUrl) => {
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
    await withServer({}, async (baseUrl) => {
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
    await withServer({ basePath: "/api/custom-commands" }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/custom-commands`);
      assert.strictEqual(res.status, 200);
    });
  });

  describe("the API description", () => {
    it("OpenAPI document is served at /openapi.json by default, describing every command route", { timeout: 20_000 }, async () => {
      await withServer({}, async (baseUrl) => {
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
      await withServer({ openApiPath: "/api/spec.json" }, async (baseUrl) => {
        assert.strictEqual((await fetch(`${baseUrl}/api/spec.json`)).status, 200);
        assert.strictEqual((await fetch(`${baseUrl}/openapi.json`)).status, 404);
      });
      await withServer({ openApiPath: false }, async (baseUrl) => {
        assert.strictEqual((await fetch(`${baseUrl}/openapi.json`)).status, 404);
      });
    });

    it("no documentation page unless asked for; Scalar and Swagger UI when configured", { timeout: 30_000 }, async () => {
      await withServer({}, async (baseUrl) => {
        assert.strictEqual((await fetch(`${baseUrl}/docs`)).status, 404);
      });
      for (const ui of ["scalar", "swagger"] as const) {
        await withServer({ docs: { ui } }, async (baseUrl) => {
          const res = await fetch(`${baseUrl}/docs`);
          assert.strictEqual(res.status, 200, `${ui} page`);
          assert.match(res.headers.get("content-type") ?? "", /text\/html/);
        });
      }
      await withServer({ docs: { ui: "scalar", path: "/reference" } }, async (baseUrl) => {
        assert.strictEqual((await fetch(`${baseUrl}/reference`)).status, 200);
      });
    });
  });

  describe("a command does not wait for views", () => {
    const open = (baseUrl: string, query: string) =>
      fetch(`${baseUrl}/api/commands/open_wallet${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletId: crypto.randomUUID() })
      });

    it("answers once the command has committed, with exactly the write's position, transaction and marker", { timeout: 20_000 }, async () => {
      await withServer({}, async (baseUrl) => {
        const res = await open(baseUrl, "");
        assert.strictEqual(res.status, 201);
        assert.deepStrictEqual(Object.keys(await jsonBody(res)), ["status", "reason", "lastPosition", "lastTransactionId", "marker"]);
      });
    });

    it("a leftover ?waitFor / ?waitTimeout from an older client is ignored: no wait, no `view` in the answer, no 400", { timeout: 20_000 }, async () => {
      await withServer({}, async (baseUrl) => {
        for (const query of ["?waitFor=wallet-balance-view", "?waitFor=nope&waitTimeout=0", "?waitTimeout=abc"]) {
          const res = await open(baseUrl, query);
          assert.strictEqual(res.status, 201, query);
          const body = await jsonBody(res);
          assert.strictEqual(body.view, undefined, query);
          assert.strictEqual(body.status, "CREATED", query);
        }
      });
    });
  });

  describe("correlation header (correlationHeaderEnabled: true)", () => {
    it("a supplied correlation id is echoed back", { timeout: 20_000 }, async () => {
      const correlationId = crypto.randomUUID();
      await withServer({ correlationHeaderEnabled: true }, async (baseUrl) => {
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
      await withServer({ correlationHeaderEnabled: true }, async (baseUrl) => {
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
      await withServer({ correlationHeaderEnabled: true }, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/commands/open_wallet`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Correlation-Id": "not-a-uuid" },
          body: JSON.stringify({ walletId: crypto.randomUUID() })
        });
        assert.strictEqual(res.status, 400);
      });
    });

    it("when disabled, an inbound correlation id is ignored (not echoed)", { timeout: 20_000 }, async () => {
      await withServer({ correlationHeaderEnabled: false }, async (baseUrl) => {
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
      await withServer({}, async (baseUrl) => {
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

// Cases that are specifically about the contract form: what the contracts alone give, and what registering the wrong commands does.
describe("commands-http from contracts (real Postgres)", () => {
  const post = (baseUrl: string, name: string, body: unknown) =>
    fetch(`${baseUrl}/api/commands/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("a command declared from its contract runs: 201, and a repeat of an idempotent-by-fail command is the framework's 409", { timeout: 20_000 }, async () => {
    const walletId = `wallet-${crypto.randomUUID()}`;
    await serve(makeCommandApiLive(contracts, implementations, {}), async (baseUrl) => {
      assert.strictEqual((await post(baseUrl, "open_wallet", { walletId })).status, 201);
      const again = await post(baseUrl, "open_wallet", { walletId });
      assert.strictEqual(again.status, 409);
      assert.strictEqual((await jsonBody(again))["violationCode"], "IDEMPOTENCY_VIOLATION");
    });
  });

  it("a domain error the contract declares is presented by its kind, with its own fields", { timeout: 20_000 }, async () => {
    await serve(makeCommandApiLive(contracts, implementations, {}), async (baseUrl) => {
      const res = await post(baseUrl, "refuse", { kind: "not_found", id: "x-1" });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.headers.get("content-type"), "application/problem+json");
      const body = await jsonBody(res);
      assert.strictEqual(body["errorType"], "NoSuchThing");
      assert.deepStrictEqual(body["fields"], { id: "x-1" });
    });
  });

  it("a bad payload is the 400 problem naming the field", { timeout: 20_000 }, async () => {
    await serve(makeCommandApiLive(contracts, implementations, {}), async (baseUrl) => {
      const res = await post(baseUrl, "open_wallet", { walletId: 42 });
      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual((await jsonBody(res))["errors"], [{ path: ["walletId"], message: "Expected string" }]);
    });
  });

  it("GET lists exactly the contracts", { timeout: 20_000 }, async () => {
    await serve(makeCommandApiLive(contracts, implementations, {}), async (baseUrl) => {
      const body = (await (await fetch(`${baseUrl}/api/commands`)).json()) as { exposedCommands: Array<{ commandType: string }> };
      assert.deepStrictEqual(body.exposedCommands.map((c) => c.commandType), ["open_wallet", "refuse", "send_confirmation"]);
    });
  });

  it("registering the wrong commands fails when the layer is built, naming every problem", () => {
    assert.throws(
      () => makeCommandApiLive(contracts, { open_wallet: OpenWallet } as never, {}),
      (error: unknown) => error instanceof Error && error.name === "ContractMismatch" && /no command for the contract "refuse"/.test(error.message)
    );
  });
});

// ADR-0017: a stored event its definition cannot read is a typed EventDecodingError in the command; over HTTP it is the generic 500 problem, which does not say
// which event (that is for the log line written where it was found), and every later request over that boundary answers the same.
describe("a command over a boundary that contains an unreadable stored event (real Postgres)", () => {
  const Ticked = defineEvent("Ticked", { schema: Schema.Struct({ entityId: Schema.String }), tags: (d) => ({ entity_id: d.entityId }) });
  const Count = defineModel({ by: "entity_id", initial: () => ({ n: 0 }) }).on(Ticked, (s) => ({ n: s.n + 1 }));
  const TickContract = commandContract({ name: "tick", input: Schema.Struct({ entityId: Schema.String }) });
  const Tick = defineCommand({ ...TickContract, model: (c) => Count.of({ id: c.entityId }), decide: (_m, c) => emit(Ticked(c)) });
  const tickContracts = [TickContract];
  const post = (baseUrl: string, entityId: string) => fetch(`${baseUrl}/api/commands/tick`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entityId }) });

  it("answers 500, the generic problem, without naming the event; the same again; and another entity is fine", { timeout: 30_000 }, async () => {
    const bad = `bad-${crypto.randomUUID().slice(0, 6)}`;
    const good = `good-${crypto.randomUUID().slice(0, 6)}`;
    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("INSERT INTO crablet_events (type, tags, data, transaction_id) VALUES ('Ticked', ARRAY['entity_id=' || $1], '{\"entity\":\"old shape\"}'::jsonb, pg_current_xact_id())", [bad]))
    );
    await serve(makeCommandApiLive(tickContracts, { tick: Tick }, {}), async (baseUrl) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await post(baseUrl, bad);
        assert.strictEqual(res.status, 500);
        const text = await res.text();
        assert.ok(!text.includes("Ticked") && !text.includes("old shape") && !text.includes("position"), `the response must not name the event: ${text}`);
      }
      assert.strictEqual((await post(baseUrl, good)).status, 201);
    });
  });
});
