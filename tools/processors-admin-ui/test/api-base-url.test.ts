// VITE_API_URL: the page calls the application on another origin directly (which needs CORS on the server); unset, URLs are relative. Every request carries the token as a bearer.
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";

const originalEnv = process.env["VITE_API_URL"];
afterEach(() => {
  if (originalEnv === undefined) delete process.env["VITE_API_URL"];
  else process.env["VITE_API_URL"] = originalEnv;
});

const freshApi = async (label: string) => (await import(`../src/api.ts?${label}`)) as typeof import("../src/api.ts");

// The client's fetch is a service (`FetchHttpClient.Fetch`): supply a recording one.
const recordRequests = () => {
  const seen: Array<{ url: string; method: string; authorization: string | null }> = [];
  const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, method: request.method, authorization: request.headers.get("authorization") });
    return new Response(JSON.stringify({ kind: "views", id: "a b/c", status: "PAUSED" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { seen, fetch };
};

describe("apiBaseUrl", () => {
  test("unset, and an empty value, are relative URLs", async () => {
    delete process.env["VITE_API_URL"];
    expect((await freshApi("unset")).apiBaseUrl).toBeUndefined();
    process.env["VITE_API_URL"] = "";
    expect((await freshApi("empty")).apiBaseUrl).toBeUndefined();
  });

  test("set: the client calls that origin, with the bearer token, and an id with a slash and a space is percent-encoded", async () => {
    process.env["VITE_API_URL"] = "http://api.example.test:8080";
    const api = await freshApi("set");
    expect(api.apiBaseUrl).toBe("http://api.example.test:8080");
    const { seen, fetch } = recordRequests();
    await Effect.runPromise(api.actCall("tok", "pause", "views", "a b/c").pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch)));
    expect(seen).toEqual([{ url: "http://api.example.test:8080/admin/processors/views/a%20b%2Fc/pause", method: "POST", authorization: "Bearer tok" }]);
  });
});
