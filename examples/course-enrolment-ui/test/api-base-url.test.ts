// VITE_API_URL: the page calls the API on another origin directly (which needs CORS on the server); unset, URLs are relative.
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";

const originalFetch = globalThis.fetch;
const originalEnv = process.env["VITE_API_URL"];
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv === undefined) delete process.env["VITE_API_URL"];
  else process.env["VITE_API_URL"] = originalEnv;
});

const freshApi = async (label: string) => (await import(`../src/api.ts?${label}`)) as typeof import("../src/api.ts");

describe("apiBaseUrl", () => {
  test("unset: relative URLs", async () => {
    delete process.env["VITE_API_URL"];
    expect((await freshApi("unset")).apiBaseUrl).toBeUndefined();
  });

  test("an empty value counts as unset", async () => {
    process.env["VITE_API_URL"] = "";
    expect((await freshApi("empty")).apiBaseUrl).toBeUndefined();
  });

  test("set: the client calls that origin", async () => {
    process.env["VITE_API_URL"] = "http://api.example.test:8080";
    const api = await freshApi("set");
    expect(api.apiBaseUrl).toBe("http://api.example.test:8080");
    const urls: Array<string> = [];
    globalThis.fetch = (async (input: Request | string | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({ courseId: "math", capacity: 3, subscribers: 1, seatsLeft: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    await Effect.runPromise(api.getCourse("math", null).pipe(Effect.provide(FetchHttpClient.layer)));
    expect(urls).toEqual(["http://api.example.test:8080/api/courses/math"]);
  });
});
