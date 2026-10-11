import { describe, expect, test } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { HttpRouter } from "effect/http";
import { apiHealthRoutes, serveHealth } from "../src/health.ts";

describe("the worker health endpoint", () => {
  test("GET /healthz answers 200 while the scope is open, anything else is a 404, and the port is closed with the scope", async () => {
    const scope = await Effect.runPromise(Scope.make());
    const { port } = await Effect.runPromise(Scope.provide(serveHealth(0), scope));
    const ok = await fetch(`http://localhost:${port}/healthz`);
    expect(ok.status).toBe(200);
    expect((await fetch(`http://localhost:${port}/api/wallets/x`)).status).toBe(404);
    expect((await fetch(`http://localhost:${port}/healthz`, { method: "POST" })).status).toBe(404);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await expect(fetch(`http://localhost:${port}/healthz`)).rejects.toThrow();
  });
});

describe("the API's probes", () => {
  const call = async (ping: Effect.Effect<unknown, unknown>, path: string, method = "GET", timeout?: string) => {
    const { handler, dispose } = HttpRouter.toWebHandler(apiHealthRoutes(ping, timeout as never), { disableLogger: true });
    try {
      const response = await handler(new Request(`http://api.test${path}`, { method }));
      return { status: response.status, body: await response.text() };
    } finally {
      await dispose();
    }
  };

  test("/healthz is 200 and never touches the database, even when it is down", async () => {
    expect(await call(Effect.fail("down"), "/healthz")).toEqual({ status: 200, body: "ok" });
  });

  test("/readyz is 200 when the database answers", async () => {
    expect(await call(Effect.void, "/readyz")).toEqual({ status: 200, body: "ok" });
  });

  test("/readyz is 503 when the query fails", async () => {
    expect(await call(Effect.fail(new Error("connection refused")), "/readyz")).toEqual({ status: 503, body: "the database did not answer" });
  });

  test("/readyz is 503 when the query does not answer in time", async () => {
    expect((await call(Effect.never, "/readyz", "GET", "50 millis")).status).toBe(503);
  });

  test("only GET is answered", async () => {
    expect((await call(Effect.void, "/readyz", "POST")).status).toBe(404);
  });
});
