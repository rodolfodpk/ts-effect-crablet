// How the page understands what the API answers. The values below are the real problem classes of @crablet/processors-http, so a problem the API gains without the page
// handling it fails to compile in src/api.ts, not here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ProcessorNotFound } from "@crablet/processors-http";
import { ProcessorsUnauthorized } from "@crablet/processors-http/Authorization";
import { adminApi, listCall, problemFromError, type CallError } from "../src/api.ts";

// What a browser supplies for the page's relative URLs.
beforeAll(() => { (globalThis as { location?: unknown }).location = new URL("http://localhost:5173"); });
afterAll(() => { delete (globalThis as { location?: unknown }).location; });

describe("problemFromError", () => {
  test("a 401 is Unauthorized", () => {
    expect(problemFromError(ProcessorsUnauthorized.of("Missing or invalid bearer token"))).toEqual({ _tag: "Unauthorized" });
  });

  test("a 404 keeps the server's words, for a kind and for an id", () => {
    expect(problemFromError(ProcessorNotFound.of("nope", undefined))).toEqual({ _tag: "NotFound", detail: 'No processors of kind "nope".' });
    expect(problemFromError(ProcessorNotFound.of("views", "ghost"))).toEqual({ _tag: "NotFound", detail: 'No processor "ghost" of kind "views".' });
  });

  // The client's fetch is a service (`FetchHttpClient.Fetch`), so each test supplies its own; swapping `globalThis.fetch` would only be seen by the first call.
  const failure = async (answer: () => Promise<Response>): Promise<CallError> => {
    const exit = await Effect.runPromiseExit(listCall("t").pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, (async () => answer()) as unknown as typeof fetch)));
    expect(exit._tag).toBe("Failure");
    return (exit as unknown as { cause: { reasons: Array<{ error?: unknown }> } }).cause.reasons.find((r) => r.error !== undefined)!.error as CallError;
  };

  test("an answer that does not match the API definition is a Mismatch", async () => {
    const error = await failure(async () => new Response(JSON.stringify({ processors: [{ kind: "views" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(Schema.isSchemaError(error)).toBe(true);
    expect(problemFromError(error)._tag).toBe("Mismatch");
  });

  test("a network failure is Unreachable", async () => {
    const error = await failure(async () => { throw new TypeError("fetch failed"); });
    expect(problemFromError(error)).toEqual({ _tag: "Unreachable" });
  });

  test("a 401 from the real endpoint, decoded by the derived client, is Unauthorized", async () => {
    const error = await failure(async () => new Response(JSON.stringify(ProcessorsUnauthorized.of("Missing or invalid bearer token")), { status: 401, headers: { "content-type": "application/problem+json" } }));
    expect(problemFromError(error)).toEqual({ _tag: "Unauthorized" });
  });

  test("the derived client is typed by the group: its endpoints are the ones the server serves", () => {
    expect(Object.keys(adminApi.groups)).toEqual(["processors"]);
  });
});
