// corsLayer: opt-in CORS for a page on another origin. No database: a tiny router stands in for the API, because what is
// tested is the middleware's behaviour on requests and responses (including a preflight and error responses).
import { describe, expect, test } from "bun:test";
import { Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { InvalidCorsConfig, corsLayer, type CorsConfig } from "../src/Cors.ts";

const routes = Layer.mergeAll(
  HttpRouter.add("POST", "/api/commands/ok", HttpServerResponse.text("ok", { status: 201, headers: { "x-correlation-id": "c1" } })),
  HttpRouter.add("POST", "/api/commands/refused", HttpServerResponse.text("no", { status: 409 })),
  HttpRouter.add("POST", "/api/commands/broken", HttpServerResponse.text("boom", { status: 500 }))
);

const serve = (cors?: CorsConfig) => {
  const app = cors === undefined ? routes : Layer.mergeAll(routes, corsLayer(cors));
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
  return {
    dispose,
    call: (method: string, path: string, headers: Record<string, string> = {}) =>
      handler(new Request(`http://api.test${path}`, { method, headers }))
  };
};
const h = (response: Response, name: string) => response.headers.get(name);
const PAGE = "http://localhost:5173";

describe("corsLayer", () => {
  test("without it, no CORS header is sent (off by default)", async () => {
    const s = serve();
    const r = await s.call("POST", "/api/commands/ok", { origin: PAGE });
    expect(r.status).toBe(201);
    expect(h(r, "access-control-allow-origin")).toBeNull();
    await s.dispose();
  });

  test("an allowed origin gets the headers on a real request, and can read the correlation id", async () => {
    const s = serve({ allowedOrigins: [PAGE] });
    const r = await s.call("POST", "/api/commands/ok", { origin: PAGE });
    expect(r.status).toBe(201);
    expect(h(r, "access-control-allow-origin")).toBe(PAGE);
    expect(h(r, "access-control-expose-headers")).toBe("X-Correlation-Id");
    await s.dispose();
  });

  test("a preflight is answered with this API's methods and headers, and caches for 10 minutes", async () => {
    const s = serve({ allowedOrigins: [PAGE] });
    const r = await s.call("OPTIONS", "/api/commands/ok", {
      origin: PAGE,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-evil"
    });
    expect(r.status).toBeLessThan(300);
    expect(h(r, "access-control-allow-origin")).toBe(PAGE);
    expect(h(r, "access-control-allow-methods")).toBe("GET, POST");
    // the header list is OURS, not whatever the browser asked for (Effect's default would reflect "x-evil")
    expect(h(r, "access-control-allow-headers")).toBe("Content-Type,X-Correlation-Id");
    expect(h(r, "access-control-max-age")).toBe("600");
    await s.dispose();
  });

  test("a preflight for a path with no route is still answered (the page asks before it knows)", async () => {
    const s = serve({ allowedOrigins: [PAGE] });
    const r = await s.call("OPTIONS", "/api/commands/not-registered", { origin: PAGE, "access-control-request-method": "POST" });
    expect(r.status).toBeLessThan(300);
    expect(h(r, "access-control-allow-origin")).toBe(PAGE);
    await s.dispose();
  });

  test("a refusal (409) and a failure (500) carry the headers too, or the page could not read them", async () => {
    const s = serve({ allowedOrigins: [PAGE] });
    for (const [path, status] of [["/api/commands/refused", 409], ["/api/commands/broken", 500]] as const) {
      const r = await s.call("POST", path, { origin: PAGE });
      expect(r.status).toBe(status);
      expect(h(r, "access-control-allow-origin")).toBe(PAGE);
    }
    await s.dispose();
  });

  test("with several origins, only a listed one is echoed back", async () => {
    const s = serve({ allowedOrigins: [PAGE, "https://app.example.org"] });
    expect(h(await s.call("POST", "/api/commands/ok", { origin: "https://app.example.org" }), "access-control-allow-origin")).toBe("https://app.example.org");
    expect(h(await s.call("POST", "/api/commands/ok", { origin: "https://evil.example.net" }), "access-control-allow-origin")).toBeNull();
    await s.dispose();
  });

  test("a predicate can allow a pattern of origins", async () => {
    const s = serve({ allowedOrigins: (origin) => origin.endsWith(".example.org") });
    expect(h(await s.call("POST", "/api/commands/ok", { origin: "https://a.example.org" }), "access-control-allow-origin")).toBe("https://a.example.org");
    expect(h(await s.call("POST", "/api/commands/ok", { origin: "https://a.example.net" }), "access-control-allow-origin")).toBeNull();
    await s.dispose();
  });

  test("credentials are sent only when asked for", async () => {
    const withCreds = serve({ allowedOrigins: [PAGE], credentials: true });
    expect(h(await withCreds.call("POST", "/api/commands/ok", { origin: PAGE }), "access-control-allow-credentials")).toBe("true");
    await withCreds.dispose();
    const without = serve({ allowedOrigins: [PAGE] });
    expect(h(await without.call("POST", "/api/commands/ok", { origin: PAGE }), "access-control-allow-credentials")).toBeNull();
    await without.dispose();
  });
});

describe("corsLayer refuses unsafe configurations at construction", () => {
  test("an empty origin list (Effect would read it as 'every origin')", () => {
    expect(() => corsLayer({ allowedOrigins: [] as never })).toThrow(InvalidCorsConfig);
  });

  test("credentials together with the wildcard origin", () => {
    expect(() => corsLayer({ allowedOrigins: ["*"], credentials: true })).toThrow(InvalidCorsConfig);
    expect(() => corsLayer({ allowedOrigins: [PAGE, "*"], credentials: true })).toThrow(InvalidCorsConfig);
  });

  test("the wildcard alone is allowed (public, credential-less API), and credentials with explicit origins are too", () => {
    expect(() => corsLayer({ allowedOrigins: ["*"] })).not.toThrow();
    expect(() => corsLayer({ allowedOrigins: [PAGE], credentials: true })).not.toThrow();
  });
});
