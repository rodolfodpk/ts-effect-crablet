// The served API's request metric (ADR-0056): one `http.server.request.duration` series per method, route template and status, for routes of
// any layer on the router, with the status the server sends when the handler failed.
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Metric, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { NodeHttpServer } from "@effect/platform-node";
import { requestMetricsLayer } from "../src/RequestMetrics.ts";

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { walletId: Schema.String }, { httpApiStatus: 404 }) {}

const api = HttpApi.make("metrics").add(
  HttpApiGroup.make("wallets").add(
    HttpApiEndpoint.get("getWallet", "/metrics-test/wallets/:walletId", { params: { walletId: Schema.String }, success: Schema.String, error: NotFound })
  )
);
const group = HttpApiBuilder.group(api, "wallets", (h) =>
  h.handle("getWallet", ({ params }) =>
    params.walletId === "missing" ? Effect.fail(new NotFound({ walletId: params.walletId })) : params.walletId === "boom" ? Effect.die("boom") : Effect.succeed(params.walletId)
  )
);
const app = Layer.mergeAll(
  HttpApiBuilder.layer(api).pipe(Layer.provide(group), Layer.provide(NodeHttpServer.layerHttpServices)),
  HttpRouter.add("GET", "/metrics-test/plain/:id", HttpServerResponse.text("ok")),
  requestMetricsLayer
);

const seriesAfter = async (paths: ReadonlyArray<string>) => {
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
  const statuses: Array<number> = [];
  for (const p of paths) statuses.push((await handler(new Request(`http://localhost${p}`))).status);
  await dispose();
  const series = (await Effect.runPromise(Metric.snapshot))
    .filter((s) => s.id === "http.server.request.duration")
    .map((s) => ({ attributes: s.attributes ?? {}, count: (s.state as { count: number }).count }))
    .filter((s) => String(s.attributes["http.route"] ?? "").startsWith("/metrics-test") || s.attributes["http.route"] === undefined);
  return { statuses, series };
};

describe("requestMetricsLayer", () => {
  test("a request is counted under its route's template, never its URL, with method, status and the unit in seconds", async () => {
    const { statuses, series } = await seriesAfter(["/metrics-test/wallets/w-1", "/metrics-test/wallets/w-2", "/metrics-test/plain/7"]);
    expect(statuses).toEqual([200, 200, 200]);
    const wallets = series.find((s) => s.attributes["http.route"] === "/metrics-test/wallets/:walletId" && s.attributes["http.response.status_code"] === "200");
    expect(wallets?.attributes).toEqual({
      unit: "seconds",
      "http.request.method": "GET",
      "http.route": "/metrics-test/wallets/:walletId",
      "http.response.status_code": "200"
    });
    expect(wallets?.count).toBeGreaterThanOrEqual(2);
    expect(series.some((s) => s.attributes["http.route"] === "/metrics-test/plain/:id")).toBe(true);
    expect(series.some((s) => JSON.stringify(s.attributes).includes("w-1"))).toBe(false);
  });

  test("a declared error is counted with its status; a defect as the 500 the server sends; no route as a 404 without a route", async () => {
    const { statuses, series } = await seriesAfter(["/metrics-test/wallets/missing", "/metrics-test/wallets/boom", "/metrics-test/nowhere"]);
    expect(statuses).toEqual([404, 500, 404]);
    const of = (route: string | undefined, status: string) =>
      series.some((s) => s.attributes["http.route"] === route && s.attributes["http.response.status_code"] === status);
    expect(of("/metrics-test/wallets/:walletId", "404")).toBe(true);
    expect(of("/metrics-test/wallets/:walletId", "500")).toBe(true);
    expect(of(undefined, "404")).toBe(true);
  });
});
