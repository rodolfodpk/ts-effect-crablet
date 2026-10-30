import { describe, expect, test } from "bun:test";
import { Effect, Layer, Redacted, Schema } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/http-api";
import { HttpRouter } from "effect/http";
import { makeInMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import { defineEvent } from "@crablet/commands/Event";
import { eventPayloadMask, personal } from "@crablet/commands/Personal";
import { eventsGroup } from "../src/EventsApi.ts";
import { authorizationFrom } from "../src/Authorization.ts";
import { makeEventsApiGroupLive, type PayloadMask } from "../src/EventsApiLive.ts";

const TOKEN = "s3cret";
const Registered = defineEvent("UserRegistered", {
  schema: Schema.Struct({ userId: Schema.String, email: personal(Schema.String), plan: Schema.String }),
  tags: (d) => ({ user_id: d.userId })
});
const Upgraded = defineEvent("PlanUpgraded", { schema: Schema.Struct({ userId: Schema.String, plan: Schema.String }), tags: (d) => ({ user_id: d.userId }) });

const api = HttpApi.make("test").add(eventsGroup);
const serve = (mask?: PayloadMask) => {
  const store = makeInMemoryEventStore();
  store.seed(
    Registered({ userId: "u1", email: "ann@example.com", plan: "free" }),
    Upgraded({ userId: "u1", plan: "pro" }),
    Registered({ userId: "u2", email: "bob@example.com", plan: "free" })
  );
  // an old shape, with a field the current definition no longer has, and a type with no definition
  store.seed({ type: "PlanUpgraded", tags: [{ key: "user_id", value: "u2" }], eventData: { userId: "u2", plan: "pro", phone: "555-0100" } });
  store.seed({ type: "Legacy", tags: [{ key: "user_id", value: "u2" }], eventData: { secret: "x" } });
  const layer = HttpApiBuilder.layer(api).pipe(
    Layer.provide(makeEventsApiGroupLive(api, mask === undefined ? {} : { mask })),
    Layer.provide(store.layer),
    Layer.provide(authorizationFrom((token) => Effect.succeed(Redacted.value(token) === TOKEN))),
    Layer.provide(NodeHttpServer.layerHttpServices)
  );
  return HttpRouter.toWebHandler(layer, { disableLogger: true });
};
const get = (app: ReturnType<typeof serve>, path: string, token: string | null = TOKEN) =>
  app.handler(new Request(`http://localhost${path}`, { headers: token === null ? {} : { Authorization: `Bearer ${token}` } }));
const mask = eventPayloadMask([Registered, Upgraded]);

describe("the event log API", () => {
  test("is behind the same authorization as the processors", async () => {
    const app = serve(mask);
    expect((await get(app, "/admin/events", null)).status).toBe(401);
    expect((await get(app, "/admin/events", "nope")).status).toBe(401);
    expect((await get(app, "/admin/events")).status).toBe(200);
    await app.dispose();
  });

  test("lists every event in log order; by types and by tags; page by page through the cursor", async () => {
    const app = serve(mask);
    const all = (await (await get(app, "/admin/events")).json()) as { events: Array<{ type: string; position: string }>; more: boolean };
    expect(all.events.map((e) => e.type)).toEqual(["UserRegistered", "PlanUpgraded", "UserRegistered", "PlanUpgraded", "Legacy"]);
    expect(all.more).toBe(false);
    const upgrades = (await (await get(app, "/admin/events?types=PlanUpgraded,Nothing")).json()) as { events: Array<{ position: string }> };
    expect(upgrades.events.map((e) => e.position)).toEqual(["2", "4"]);
    const u2 = (await (await get(app, "/admin/events?tag=user_id=u2&types=UserRegistered")).json()) as { events: Array<{ position: string }> };
    expect(u2.events.map((e) => e.position)).toEqual(["3"]);
    // a repeated tag: an event must carry all of them
    const both = (await (await get(app, "/admin/events?tag=user_id=u1&tag=user_id=u2")).json()) as { events: unknown[] };
    expect(both.events).toEqual([]);
    const first = (await (await get(app, "/admin/events?limit=2")).json()) as { events: Array<{ position: string }>; cursor: string; more: boolean };
    expect([first.events.map((e) => e.position), first.more]).toEqual([["1", "2"], true]);
    const next = (await (await get(app, `/admin/events?limit=2&after=${encodeURIComponent(first.cursor)}`)).json()) as { events: Array<{ position: string }> };
    expect(next.events.map((e) => e.position)).toEqual(["3", "4"]);
    await app.dispose();
  });

  test("a payload is shown through the mask: personal fields redacted, unknown keys dropped, a type with no definition withheld", async () => {
    const app = serve(mask);
    const page = (await (await get(app, "/admin/events")).json()) as { events: Array<{ type: string; data: unknown; dataShown: boolean }> };
    expect(page.events[0]).toMatchObject({ data: { userId: "u1", email: "[redacted]", plan: "free" }, dataShown: true });
    expect(page.events[3]).toMatchObject({ data: { userId: "u2", plan: "pro" }, dataShown: true }); // `phone` is not in the definition: dropped
    expect(page.events[4]).toMatchObject({ type: "Legacy", data: null, dataShown: false });
    await app.dispose();
    // no mask: nothing is shown
    const bare = serve();
    const none = (await (await get(bare, "/admin/events")).json()) as { events: Array<{ dataShown: boolean }> };
    expect(none.events.every((e) => !e.dataShown)).toBe(true);
    await bare.dispose();
  });

  test("a malformed tag, limit or cursor is a 400 problem", async () => {
    const app = serve(mask);
    for (const path of ["/admin/events?tag=novalue", "/admin/events?tag==x", "/admin/events?limit=0", "/admin/events?limit=501", "/admin/events?limit=x", "/admin/events?after=nope"]) {
      const res = await get(app, path);
      expect([path, res.status]).toEqual([path, 400]);
      expect(await res.json()).toMatchObject({ type: "urn:crablet:problem:events-api:bad-request", status: 400 });
    }
    await app.dispose();
  });

  test("the description has the path, behind the bearer scheme", () => {
    const spec = OpenApi.fromApi(api) as unknown as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toContain("/admin/events");
  });
});
