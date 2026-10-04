// Runs under Node (Testcontainers) - see NOTES.md. The consistency wrapper over REAL views, behind a real HttpApi: three views that apply the
// same event after different delays, and one read endpoint that uses all three. Checks what a client sees on the wire (status, headers,
// problem bodies), what the OpenAPI description promises, and what the derived client resolves.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiClient, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { formatMarker } from "@crablet/eventstore/Marker";
import { CommandApiBadRequest } from "@crablet/commands-http/ProblemDetail";
import { makeViewsProcessor } from "@crablet/views";
import { makeTransactionalViewProjector } from "@crablet/views/ViewProjector";
import { viewSubscriptionOf } from "@crablet/views/ViewSubscription";
import type { ViewsConfig } from "@crablet/views/ViewsConfig";
import { makeConsistentRead } from "../../src/ConsistentRead.ts";
import type { ConsistencyParams } from "../../src/ReadConsistency.ts";
import { ViewsUnavailable } from "../../src/ReadProblems.ts";
import { ReadSuccess, consistencyQuery, readProblems } from "../../src/ReadQuery.ts";

// Three views of one event type. Each waits `delayMs` before it applies a batch, so right after a write none of the slow ones has it.
const views = [
  { name: "rc-fast", table: "rc_fast", delayMs: 0 },
  { name: "rc-medium", table: "rc_medium", delayMs: 200 },
  { name: "rc-slow", table: "rc_slow", delayMs: 400 }
] as const;
const EVENT = "RcEvent";
const subscriptions = views.map((v) => viewSubscriptionOf(v.name, { eventTypes: new Set([EVENT]) }));

const Thing = Schema.Struct({ id: Schema.String, inFast: Schema.Boolean, inMedium: Schema.Boolean, inSlow: Schema.Boolean });
const Api = HttpApi.make("rc").add(
  HttpApiGroup.make("reads").add(
    HttpApiEndpoint.get("getThing", "/api/things/:id", {
      params: { id: Schema.String },
      query: { ...consistencyQuery, limit: Schema.optionalKey(Schema.String) },
      success: ReadSuccess(Thing),
      error: [...readProblems]
    })
  )
);

interface ThingRequest {
  readonly params: { readonly id: string };
  readonly query: ConsistencyParams & { readonly limit?: string | undefined };
}

const read = makeConsistentRead();
const GroupLive = HttpApiBuilder.group(Api, "reads", (handlers) =>
  Effect.succeed(
    handlers.handle(
      "getThing",
      read(
        {
          reads: subscriptions,
          consistency: { clientMayRelax: true },
          parse: (request: ThingRequest) =>
            request.query.limit === undefined || /^[1-9][0-9]*$/.test(request.query.limit)
              ? Effect.succeed(undefined)
              : Effect.fail(CommandApiBadRequest.of("limit must be a whole number from 1 to 100"))
        },
        (_parsed: undefined, request: ThingRequest) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const present = (table: string) =>
              Effect.map(Effect.orDie(sql.unsafe<{ id: string }>(`SELECT id FROM ${table} WHERE id = $1`, [request.params.id])), (rows) => rows.length > 0);
            return {
              id: request.params.id,
              inFast: yield* present("rc_fast"),
              inMedium: yield* present("rc_medium"),
              inSlow: yield* present("rc_slow")
            };
          })
      )
    )
  )
);

const viewsConfig: ViewsConfig = {
  enabled: true,
  pollingIntervalMs: 50,
  batchSize: 100,
  backoffEnabled: false,
  backoffThreshold: 3,
  backoffMultiplier: 2,
  backoffMaxSeconds: 120,
  leaderElectionRetryIntervalMs: 30_000,
  maxErrors: 5
};

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | SqlClient.SqlClient | PgClient.PgClient | HttpServer.HttpServer, never>;
let stopViews: () => Promise<unknown>;
let base: string;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  const core = Layer.provideMerge(EventStoreLive, pgLayer);
  const server = Layer.provideMerge(HttpRouter.serve(HttpApiBuilder.layer(Api).pipe(Layer.provide(GroupLive))), NodeHttpServer.layer(createServer, { port: 0 }));
  runtime = ManagedRuntime.make(Layer.provideMerge(server, core) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient | PgClient.PgClient | HttpServer.HttpServer, never>);

  const projectors = await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const list = [];
      for (const v of views) {
        yield* sql.unsafe(`CREATE TABLE ${v.table} (id text primary key)`);
        const projector = yield* makeTransactionalViewProjector(v.name, (event, tx) =>
          Effect.asVoid(tx.unsafe(`INSERT INTO ${v.table} (id) VALUES ($1) ON CONFLICT DO NOTHING`, [event.tags.find((t) => t.key === "row")?.value]))
        );
        list.push(v.delayMs > 0 ? { ...projector, handle: (events: Parameters<typeof projector.handle>[0]) => Effect.andThen(Effect.sleep(`${v.delayMs} millis`), projector.handle(events)) } : projector);
      }
      return list;
    })
  );
  const handle = await runtime.runPromise(makeViewsProcessor({ config: viewsConfig, projectors, subscriptions, instanceId: `i-${crypto.randomUUID()}` }));
  await runtime.runPromise(handle.service.start);
  stopViews = () => runtime.runPromise(handle.service.stop);

  const server_ = await runtime.runPromise(Effect.gen(function* () { return yield* HttpServer.HttpServer; }));
  base = `http://localhost:${server_.address._tag === "UnixPathAddress" ? 0 : server_.address.port}`;
}, { timeout: 90_000 });

after(async () => {
  await stopViews();
  await runtime.dispose();
  await db.stop();
});

// Append one event; the response's marker, as a command's response would carry it.
const write = async (id: string) => {
  const { transactionId, lastPosition } = await runtime.runPromise(
    Effect.flatMap(EventStore, (store) => store.append([AppendEvent.of(EVENT, "row", id, {})]))
  );
  return formatMarker({ transactionId, position: lastPosition });
};

interface Got {
  readonly status: number;
  readonly headers: Headers;
  readonly json: any;
  readonly ms: number;
}
const get = async (id: string, query: Record<string, string> = {}): Promise<Got> => {
  const started = Date.now();
  const res = await fetch(`${base}/api/things/${id}?${new URLSearchParams(query)}`);
  return { status: res.status, headers: res.headers, json: await res.json(), ms: Date.now() - started };
};

const newId = () => `thing-${crypto.randomUUID()}`;

describe("a read consistent with a write, over views that are 0, 200 and 400 ms behind", () => {
  it("with the write's marker: waits for ALL the views the read uses, then answers 200 with the write in every one", { timeout: 20_000 }, async () => {
    const id = newId();
    const marker = await write(id);
    const got = await get(id, { consistentWith: marker });
    assert.strictEqual(got.status, 200);
    assert.deepStrictEqual(got.json, { id, inFast: true, inMedium: true, inSlow: true });
    assert.strictEqual(got.headers.get("crablet-consistency"), null, "fresh: no stale header");
    assert.ok(got.ms >= 250, `it waited for the slowest view (took ${got.ms} ms)`);
  });

  it("with no parameters (the server default is latest): the same", { timeout: 20_000 }, async () => {
    const id = newId();
    await write(id);
    const got = await get(id);
    assert.strictEqual(got.status, 200);
    assert.deepStrictEqual(got.json, { id, inFast: true, inMedium: true, inSlow: true });
  });

  it("strict and out of time: 503 problem+json with Retry-After, naming the views that are behind", { timeout: 20_000 }, async () => {
    const id = newId();
    const marker = await write(id);
    const got = await get(id, { consistentWith: marker, waitTimeout: "100" });
    assert.strictEqual(got.status, 503);
    assert.match(got.headers.get("content-type") ?? "", /application\/problem\+json/);
    assert.strictEqual(got.headers.get("retry-after"), "1");
    assert.strictEqual(got.json.reason, "lagging");
    assert.strictEqual(got.json.retryAfterSeconds, 1);
    const behind = (got.json.views as Array<{ name: string; reason: string }>).map((v) => v.name);
    assert.ok(behind.includes("rc-slow") && behind.includes("rc-medium"), `the slow views are named (got ${behind.join(", ")})`);
    assert.ok(got.json.views.every((v: { reason: string }) => v.reason === "lagging"));
    // and once they have caught up, the same request is fine
    assert.strictEqual((await get(id, { consistentWith: marker })).status, 200);
  });

  it("bounded and out of time: 200 with the data as it is, and the stale header", { timeout: 20_000 }, async () => {
    const id = newId();
    const marker = await write(id);
    const got = await get(id, { consistentWith: marker, consistency: "bounded", waitTimeout: "50" });
    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.headers.get("crablet-consistency"), "stale");
    assert.strictEqual(got.json.inSlow, false, "the slow view really was behind: this is a stale read");
  });

  it("eventual: answers at once, without waiting, and says nothing about staleness", { timeout: 20_000 }, async () => {
    const id = newId();
    const marker = await write(id);
    const got = await get(id, { consistentWith: marker, consistency: "eventual" });
    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.headers.get("crablet-consistency"), null);
    assert.strictEqual(got.json.inSlow, false);
    assert.ok(got.ms < 200, `it did not wait (took ${got.ms} ms)`);
  });

  it("a bad request is a 400 at once and never waits (a write is pending in a slow view)", { timeout: 20_000 }, async () => {
    const id = newId();
    const marker = await write(id);
    const started = Date.now();
    const results = await Promise.all([
      get(id, { limit: "0" }),
      get(id, { consistency: "weak" }),
      get(id, { consistentWith: "nonsense" }),
      get(id, { waitTimeout: "abc" }),
      get(id, { consistentWith: "99999999999999999:1" }) // beyond the end of the log
    ]);
    for (const got of results) {
      assert.strictEqual(got.status, 400);
      assert.match(got.headers.get("content-type") ?? "", /application\/problem\+json/);
      assert.strictEqual(got.json.title, "Bad Request");
    }
    assert.ok(Date.now() - started < 300, "no 400 waited for the slow views");
    assert.match(results[4]!.json.detail, /beyond/);
    await get(id, { consistentWith: marker }); // let the views catch up before the next test
  });
});

describe("the contract: what the OpenAPI description promises and the derived client resolves", () => {
  it("the description lists the stale header on 200, Retry-After on 503, the 400, and the consistency parameters", () => {
    const operation = (OpenApi.fromApi(Api) as any).paths["/api/things/{id}"].get;
    assert.ok(operation.responses["200"].headers["crablet-consistency"], "200 documents the stale header");
    assert.strictEqual(operation.responses["200"].headers["crablet-consistency"].required, false);
    assert.ok(operation.responses["503"].headers["retry-after"], "503 documents Retry-After");
    assert.strictEqual(operation.responses["503"].headers["retry-after"].required, false, "absent for a failed view");
    assert.ok(operation.responses["400"], "400 is declared");
    const parameters = operation.parameters.map((p: { name: string }) => p.name);
    for (const name of ["consistentWith", "consistency", "waitTimeout"]) assert.ok(parameters.includes(name), `${name} is a parameter`);
  });

  it("the derived client resolves { body, headers }, and a refused strict read fails with the decoded ViewsUnavailable", { timeout: 20_000 }, async () => {
    const id = newId();
    const marker = await write(id);
    const run = <A, E>(effect: Effect.Effect<A, E, any>) => runtime.runPromise(Effect.provide(effect, FetchHttpClient.layer) as never) as Promise<A>;
    const client = await run(HttpApiClient.make(Api, { baseUrl: base }));

    const stale = await run(client.reads.getThing({ params: { id }, query: { consistentWith: marker, consistency: "bounded", waitTimeout: "50" } }));
    assert.strictEqual(stale.body.id, id);
    assert.strictEqual(stale.headers["crablet-consistency"], "stale");

    const refused = await run(Effect.flip(client.reads.getThing({ params: { id }, query: { consistentWith: marker, waitTimeout: "50" } })));
    assert.ok(refused instanceof ViewsUnavailable, `expected ViewsUnavailable, got ${String(refused)}`);
    assert.strictEqual((refused as ViewsUnavailable).reason, "lagging");

    const fresh = await run(client.reads.getThing({ params: { id }, query: { consistentWith: marker } }));
    assert.deepStrictEqual(fresh.body, { id, inFast: true, inMedium: true, inSlow: true });
    assert.deepStrictEqual(fresh.headers, {});
  });
});

describe("latest while a transaction is open (the poller only reads below the oldest open transaction)", () => {
  it("a strict read cannot be consistent and answers 503; once the transaction ends it can", { timeout: 40_000 }, async () => {
    const holder = new Client({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, user: db.connInfo.username, password: db.connInfo.password });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_current_xact_id()"); // assigns an xid, so this transaction holds back the poller's horizon
      const id = newId();
      await write(id); // committed, with a LATER xid than the open transaction
      const refused = await get(id, { waitTimeout: "800" });
      assert.strictEqual(refused.status, 503, "the views cannot pass an event above the oldest open transaction");
      assert.strictEqual(refused.json.reason, "lagging");

      const eventual = await get(id, { consistency: "eventual" });
      assert.strictEqual(eventual.status, 200, "a read that does not wait is unaffected");
      assert.strictEqual(eventual.json.inFast, false);

      await holder.query("COMMIT");
      const fresh = await get(id);
      assert.strictEqual(fresh.status, 200);
      assert.deepStrictEqual(fresh.json, { id, inFast: true, inMedium: true, inSlow: true });
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });
});
