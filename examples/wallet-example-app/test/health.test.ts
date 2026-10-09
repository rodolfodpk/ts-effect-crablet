import { describe, expect, test } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { serveHealth } from "../src/health.ts";

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
