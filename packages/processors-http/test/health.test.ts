import { describe, expect, test } from "bun:test";
import { Effect, Layer, Ref } from "effect";
import { HttpRouter } from "effect/http";
import type { ModuleStatus } from "@crablet/modules/Processors";
import { Processors } from "@crablet/modules/Processors";
import { healthRoutes, type HealthOptions } from "../src/Health.ts";

// A `Processors` whose status is whatever the test says, and which counts how often it was asked.
const processorsReporting = (modules: ReadonlyArray<ModuleStatus>) =>
  Effect.map(Ref.make(0), (asked) => ({
    asked,
    layer: Layer.succeed(Processors, { sources: [], status: Effect.as(Ref.update(asked, (n) => n + 1), modules) })
  }));

const call = async (options: HealthOptions, path: string, init: { method?: string; modules?: ReadonlyArray<ModuleStatus> } = {}) => {
  const { asked, layer } = await Effect.runPromise(processorsReporting(init.modules ?? []));
  const { handler, dispose } = HttpRouter.toWebHandler(healthRoutes(options).pipe(Layer.provide(layer)), { disableLogger: true });
  try {
    const response = await handler(new Request(`http://process.test${path}`, { method: init.method ?? "GET" }));
    return { status: response.status, type: response.headers.get("content-type"), body: await response.text(), asked: await Effect.runPromise(Ref.get(asked)) };
  } finally {
    await dispose();
  }
};

describe("/healthz, liveness", () => {
  test("is 200 while the process answers, and asks neither the database nor the modules", async () => {
    const r = await call({ ping: Effect.fail("down") }, "/healthz");
    expect([r.status, r.body, r.asked]).toEqual([200, "ok", 0]);
  });
});

describe("/readyz, readiness", () => {
  test("is 200 when the ping answers", async () => {
    expect((await call({ ping: Effect.void }, "/readyz")).status).toBe(200);
  });

  test("is 503 when the ping fails", async () => {
    const r = await call({ ping: Effect.fail(new Error("connection refused")) }, "/readyz");
    expect([r.status, r.body]).toEqual([503, "the database did not answer"]);
  });

  test("is 503 when the ping does not answer within the timeout", async () => {
    expect((await call({ ping: Effect.never, readyTimeout: "50 millis" }, "/readyz")).status).toBe(503);
  });

  test("a ping that dies is a 503 too, not a 500", async () => {
    expect((await call({ ping: Effect.die("boom") }, "/readyz")).status).toBe(503);
  });

  test("does not depend on leadership: a process that leads nothing is ready", async () => {
    const r = await call({ ping: Effect.void }, "/readyz", { modules: [{ kind: "views", runs: true, leads: false }] });
    expect([r.status, r.asked]).toEqual([200, 0]);
  });
});

describe("/status, what the process runs and leads", () => {
  test("is the modules' status, read from `Processors` at each request, with the instance and the uptime", async () => {
    const modules = [
      { kind: "views", runs: true, leads: true },
      { kind: "outbox", runs: true, leads: false },
      { kind: "automations", runs: false, leads: false }
    ];
    const r = await call({ ping: Effect.fail("down"), instance: "wallet-views-1" }, "/status", { modules });
    expect(r.status).toBe(200);
    expect(r.type).toContain("application/json");
    expect(JSON.parse(r.body)).toEqual({ instance: "wallet-views-1", uptimeSeconds: 0, modules });
    expect(r.asked).toBe(1);
  });

  test("without an instance, the field is left out", async () => {
    expect(JSON.parse((await call({ ping: Effect.void }, "/status")).body)).toEqual({ uptimeSeconds: 0, modules: [] });
  });
});

test("only GET is answered", async () => {
  for (const path of ["/healthz", "/readyz", "/status"]) expect((await call({ ping: Effect.void }, path, { method: "POST" })).status).toBe(404);
});
