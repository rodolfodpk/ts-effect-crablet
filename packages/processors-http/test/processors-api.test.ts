import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { Effect, Exit, Layer, Redacted } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/http-api";
import { HttpRouter } from "effect/http";
import type { Backlog, ProcessorDetails, ProcessorManagementService } from "@crablet/event-poller/ProcessorManagementService";
import type { ProcessorStatus } from "@crablet/event-poller/ProcessorStatus";
import * as ProgressCursorNS from "@crablet/event-poller/ProgressCursor";
import { processorsGroup } from "../src/ProcessorsApi.ts";
import { authorizationFrom } from "../src/Authorization.ts";
import { actOnProcessor, listProcessors, makeProcessorsApiGroupLive, type ProcessorSource } from "../src/ProcessorsApiLive.ts";

const TOKEN = "s3cret";

// A management service over a few plain maps: enough to see what the API does with what a real one says.
const fakeService = (
  initial: Record<string, { status: ProcessorStatus; errorCount?: number; lastError?: string; backlog?: Backlog | "unreadable"; backedOff?: boolean }>
): ProcessorManagementService<string> & { readonly state: Map<string, { status: ProcessorStatus; errorCount: number; lastError: string | null }> } => {
  const state = new Map(Object.entries(initial).map(([id, v]) => [id, { status: v.status, errorCount: v.errorCount ?? 0, lastError: v.lastError ?? null }]));
  const known = (id: string) => state.has(id);
  const set = (id: string, patch: Partial<{ status: ProcessorStatus; errorCount: number; lastError: string | null }>) => state.set(id, { ...state.get(id)!, ...patch });
  return {
    state,
    pause: (id) => Effect.sync(() => (known(id) ? (set(id, { status: "PAUSED" }), true) : false)),
    resume: (id) => Effect.sync(() => (known(id) ? (set(id, { status: "ACTIVE" }), true) : false)),
    reset: (id) => Effect.sync(() => (known(id) ? (set(id, { status: "ACTIVE", errorCount: 0 }), true) : false)),
    getStatus: (id) => Effect.sync(() => state.get(id)?.status ?? "ACTIVE"),
    getAllStatuses: Effect.sync(() => new Map([...state].map(([id, v]) => [id, v.status] as const))),
    getAllDetails: Effect.sync(() => new Map<string, ProcessorDetails>([...state].map(([id, v]) => [id, { errorCount: v.errorCount, lastError: v.lastError }] as const))),
    getLag: () => Effect.succeed(null),
    getBacklog: (id) => {
      const b = initial[id]?.backlog;
      return b === "unreadable" ? Effect.fail(new Error("db down")) : Effect.succeed(b ?? null);
    },
    getBackoffInfo: () => Effect.succeed(null),
    getAllBackoffInfo: Effect.sync(() => new Map([...Object.entries(initial)].filter(([, v]) => v.backedOff === true).map(([id]) => [id, { emptyPollCount: 5, currentSkipCounter: 2 }] as const)))
  };
};

const backlog = (pendingEvents: number, oldestPendingSeconds: number | null, position = 40n): Backlog => ({ cursor: ProgressCursorNS.of("9", position), pendingEvents, capped: false, oldestPendingSeconds });

const makeSources = () => {
  const views = fakeService({
    "wallet-balance-view": { status: "ACTIVE", backlog: backlog(7, 12.5, 120n) },
    "wallet-summary-view": { status: "FAILED", errorCount: 10, lastError: "boom", backlog: "unreadable", backedOff: true }
  });
  const outbox = fakeService({ '["wallet-events","LogPublisher"]': { status: "ACTIVE", backlog: backlog(0, null) } });
  const sources: ReadonlyArray<ProcessorSource> = [
    { kind: "views", service: views, describe: (id) => (id === "wallet-balance-view" ? "balances" : undefined) },
    { kind: "outbox", service: outbox }
  ];
  return { views, outbox, sources };
};

const api = HttpApi.make("test").add(processorsGroup);
const serveWith = (sources: ReadonlyArray<ProcessorSource>, check: (token: string) => Effect.Effect<boolean, unknown> = (t) => Effect.succeed(t === TOKEN)) => {
  const layer = HttpApiBuilder.layer(api).pipe(
    Layer.provide(makeProcessorsApiGroupLive(api, sources)),
    Layer.provide(authorizationFrom((token) => check(Redacted.value(token)))),
    Layer.provide(NodeHttpServer.layerHttpServices)
  );
  return HttpRouter.toWebHandler(layer, { disableLogger: true });
};

const call = (app: ReturnType<typeof serveWith>, method: string, path: string, token: string | null = TOKEN) =>
  app.handler(new Request(`http://localhost${path}`, { method, headers: token === null ? {} : { Authorization: `Bearer ${token}` } }));

describe("the admin API: who may call it", () => {
  test("no token, or a wrong one, is a 401 problem; the right one is let through", async () => {
    const app = serveWith(makeSources().sources);
    const none = await call(app, "GET", "/admin/processors", null);
    expect(none.status).toBe(401);
    expect(none.headers.get("content-type")).toContain("application/problem+json");
    expect(await none.json()).toMatchObject({ type: "urn:crablet:problem:processors-api:unauthorized", status: 401 });
    expect((await call(app, "GET", "/admin/processors", "nope")).status).toBe(401);
    expect((await call(app, "POST", "/admin/processors/views/wallet-balance-view/pause", "nope")).status).toBe(401);
    expect((await call(app, "GET", "/admin/processors")).status).toBe(200);
    await app.dispose();
  });

  test("a check that fails is a 401; one that dies is a server error; neither lets the request through", async () => {
    const failing = serveWith(makeSources().sources, () => Effect.fail("nope"));
    expect((await call(failing, "GET", "/admin/processors")).status).toBe(401);
    const dying = serveWith(makeSources().sources, () => Effect.die(new Error("identity service down")));
    const res = await call(dying, "POST", "/admin/processors/views/wallet-balance-view/pause");
    expect(res.status).toBe(500);
    await failing.dispose();
    await dying.dispose();
  });

  test("the API cannot be mounted without an authorization: a server built without one fails to start, naming the missing service (a start-up error, not a compile error: the layer's type does not show it)", async () => {
    const layer = HttpApiBuilder.layer(api).pipe(Layer.provide(makeProcessorsApiGroupLive(api, [])), Layer.provide(NodeHttpServer.layerHttpServices));
    const served = HttpRouter.serve(layer).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: 0 })));
    const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(served)).pipe(Effect.timeout("5 seconds")));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("ProcessorsAuthorization");
    // and through the web handler, the first request is refused for the same reason rather than answered
    const app = HttpRouter.toWebHandler(layer, { disableLogger: true });
    await expect(app.handler(new Request("http://localhost/admin/processors", { headers: { Authorization: `Bearer ${TOKEN}` } }))).rejects.toThrow("ProcessorsAuthorization");
  });

  test("the description declares the bearer scheme", () => {
    const spec = OpenApi.fromApi(api) as unknown as { components: { securitySchemes: Record<string, unknown> }; paths: Record<string, unknown> };
    expect(JSON.stringify(spec.components.securitySchemes)).toContain("bearer");
    expect(Object.keys(spec.paths)).toContain("/admin/processors");
  });
});

describe("the admin API: listing", () => {
  test("every processor of every kind, sorted, with status, failure, cursor, backlog and backoff", async () => {
    const { sources } = makeSources();
    const app = serveWith(sources);
    const res = await call(app, "GET", "/admin/processors");
    const body = (await res.json()) as { processors: Array<Record<string, unknown>> };
    expect(body.processors.map((p) => `${p.kind}/${p.id}`)).toEqual(['outbox/["wallet-events","LogPublisher"]', "views/wallet-balance-view", "views/wallet-summary-view"]);
    expect(body.processors[1]).toEqual({
      kind: "views", id: "wallet-balance-view", description: "balances", status: "ACTIVE", errorCount: 0, lastError: null,
      cursorPosition: "120", pendingEvents: 7, pendingCapped: false, oldestPendingSeconds: 12.5, backedOff: false
    });
    expect(body.processors[2]).toMatchObject({ status: "FAILED", errorCount: 10, lastError: "boom", cursorPosition: null, pendingEvents: null, backedOff: true, description: null });
    await app.dispose();
  });

  test("listProcessors on its own: a backlog that cannot be read leaves the processor listed", async () => {
    const { sources } = makeSources();
    const all = await Effect.runPromise(listProcessors(sources));
    expect(all).toHaveLength(3);
    expect(all.find((p) => p.id === "wallet-summary-view")?.pendingEvents).toBeNull();
  });
});

describe("the admin API: pause, resume, reset", () => {
  test("pause then resume change the status the list reports", async () => {
    const { sources } = makeSources();
    const app = serveWith(sources);
    const paused = await call(app, "POST", "/admin/processors/views/wallet-balance-view/pause");
    expect(paused.status).toBe(200);
    expect(await paused.json()).toEqual({ kind: "views", id: "wallet-balance-view", status: "PAUSED" });
    const listed = (await (await call(app, "GET", "/admin/processors")).json()) as { processors: Array<{ id: string; status: string }> };
    expect(listed.processors.find((p) => p.id === "wallet-balance-view")?.status).toBe("PAUSED");
    expect(await (await call(app, "POST", "/admin/processors/views/wallet-balance-view/resume")).json()).toMatchObject({ status: "ACTIVE" });
    await app.dispose();
  });

  test("reset takes a FAILED processor back to ACTIVE with no errors, and does not touch its cursor", async () => {
    const { sources, views } = makeSources();
    const app = serveWith(sources);
    const res = await call(app, "POST", "/admin/processors/views/wallet-summary-view/reset");
    expect(await res.json()).toEqual({ kind: "views", id: "wallet-summary-view", status: "ACTIVE" });
    expect(views.state.get("wallet-summary-view")).toMatchObject({ status: "ACTIVE", errorCount: 0 });
    await app.dispose();
  });

  test("an id with brackets, quotes and commas (an outbox publisher) travels percent-encoded", async () => {
    const { sources, outbox } = makeSources();
    const app = serveWith(sources);
    const id = encodeURIComponent('["wallet-events","LogPublisher"]');
    const res = await call(app, "POST", `/admin/processors/outbox/${id}/pause`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "outbox", id: '["wallet-events","LogPublisher"]', status: "PAUSED" });
    expect(outbox.state.get('["wallet-events","LogPublisher"]')?.status).toBe("PAUSED");
    await app.dispose();
  });

  test("an unknown kind or id is a 404 problem that says which", async () => {
    const app = serveWith(makeSources().sources);
    const kind = await call(app, "POST", "/admin/processors/nope/x/pause");
    expect(kind.status).toBe(404);
    expect(kind.headers.get("content-type")).toContain("application/problem+json");
    expect(await kind.json()).toMatchObject({ type: "urn:crablet:problem:processors-api:not-found", detail: 'No processors of kind "nope".' });
    const id = await call(app, "POST", "/admin/processors/views/nope/reset");
    expect(id.status).toBe(404);
    expect(await id.json()).toMatchObject({ detail: 'No processor "nope" of kind "views".' });
    await app.dispose();
  });

  test("actOnProcessor on its own leaves other processors alone", async () => {
    const { sources, views } = makeSources();
    await Effect.runPromise(actOnProcessor(sources, "pause", "views", "wallet-balance-view"));
    expect(views.state.get("wallet-summary-view")?.status).toBe("FAILED");
  });
});

describe("the sources", () => {
  test("two sources of the same kind are refused when the layer is built", () => {
    const { views } = makeSources();
    expect(() => makeProcessorsApiGroupLive(api, [{ kind: "views", service: views }, { kind: "views", service: views }])).toThrow('processor kind "views"');
  });
});
