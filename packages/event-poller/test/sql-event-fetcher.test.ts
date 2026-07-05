// Runs under Node (Testcontainers) - see NOTES.md.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { makeSqlEventFetcher } from "../src/SqlEventFetcher.ts";
import * as EventSelection from "../src/EventSelection.ts";

let db: TestDb;
let layer: Layer.Layer<EventStore | SqlClient.SqlClient, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  layer = Layer.provideMerge(EventStoreLive, pgLayer) as unknown as Layer.Layer<
    EventStore | SqlClient.SqlClient,
    never
  >;
}, { timeout: 60_000 });

after(async () => {
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, EventStore | SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

describe("SqlEventFetcher (against real crablet_events/crablet_event_tags)", () => {
  it("eventTypes: only matching types are returned", async () => {
    const marker = crypto.randomUUID();
    await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.appendCommutative([
          AppendEvent.of("FetchTestTypeA", "marker", marker, {}),
          AppendEvent.of("FetchTestTypeB", "marker", marker, {})
        ]);
      })
    );

    const rows = await run(
      Effect.gen(function* () {
        const fetcher = yield* makeSqlEventFetcher<string>(
          EventSelection.of({ eventTypes: new Set(["FetchTestTypeA"]) })
        );
        return yield* fetcher.fetchEvents("proc", 0n, 1000);
      })
    );

    const matching = rows.filter((e) => e.tags.some((t) => t.key === "marker" && t.value === marker));
    assert.deepStrictEqual(matching.map((e) => e.type), ["FetchTestTypeA"]);
  });

  it("requiredTags: ALL keys must be present", async () => {
    const marker = crypto.randomUUID();
    await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.appendCommutative([
          AppendEvent.builder("FetchTestRequired").tag("marker", marker).tag("k1", "v1").data({}).build(),
          AppendEvent.builder("FetchTestRequired")
            .tag("marker", marker)
            .tag("k1", "v1")
            .tag("k2", "v2")
            .data({})
            .build()
        ]);
      })
    );

    const rows = await run(
      Effect.gen(function* () {
        const fetcher = yield* makeSqlEventFetcher<string>(
          EventSelection.of({ eventTypes: new Set(["FetchTestRequired"]), requiredTags: new Set(["k1", "k2"]) })
        );
        return yield* fetcher.fetchEvents("proc", 0n, 1000);
      })
    );

    const matching = rows.filter((e) => e.tags.some((t) => t.key === "marker" && t.value === marker));
    assert.strictEqual(matching.length, 1);
    assert.ok(matching[0]!.tags.some((t) => t.key === "k2"));
  });

  it("anyOfTags: at least one key must be present", async () => {
    const marker = crypto.randomUUID();
    await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.appendCommutative([
          AppendEvent.builder("FetchTestAnyOf").tag("marker", marker).tag("k1", "v1").data({}).build(),
          AppendEvent.builder("FetchTestAnyOf").tag("marker", marker).tag("k_other", "v").data({}).build()
        ]);
      })
    );

    const rows = await run(
      Effect.gen(function* () {
        const fetcher = yield* makeSqlEventFetcher<string>(
          EventSelection.of({ eventTypes: new Set(["FetchTestAnyOf"]), anyOfTags: new Set(["k1", "k9"]) })
        );
        return yield* fetcher.fetchEvents("proc", 0n, 1000);
      })
    );

    const matching = rows.filter((e) => e.tags.some((t) => t.key === "marker" && t.value === marker));
    assert.strictEqual(matching.length, 1);
    assert.ok(matching[0]!.tags.some((t) => t.key === "k1"));
  });

  it("exactTags: ALL key=value pairs must match exactly", async () => {
    const marker = crypto.randomUUID();
    await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.appendCommutative([
          AppendEvent.builder("FetchTestExact").tag("marker", marker).tag("status", "open").data({}).build(),
          AppendEvent.builder("FetchTestExact").tag("marker", marker).tag("status", "closed").data({}).build()
        ]);
      })
    );

    const rows = await run(
      Effect.gen(function* () {
        const fetcher = yield* makeSqlEventFetcher<string>(
          EventSelection.of({
            eventTypes: new Set(["FetchTestExact"]),
            exactTags: new Map([["status", "open"]])
          })
        );
        return yield* fetcher.fetchEvents("proc", 0n, 1000);
      })
    );

    const matching = rows.filter((e) => e.tags.some((t) => t.key === "marker" && t.value === marker));
    assert.strictEqual(matching.length, 1);
    assert.ok(matching[0]!.tags.some((t) => t.key === "status" && t.value === "open"));
  });

  it("batchSize acts as a hard LIMIT", async () => {
    const marker = crypto.randomUUID();
    await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.appendCommutative([
          AppendEvent.of("FetchTestLimit", "marker", marker, {}),
          AppendEvent.of("FetchTestLimit", "marker", marker, {}),
          AppendEvent.of("FetchTestLimit", "marker", marker, {})
        ]);
      })
    );

    const rows = await run(
      Effect.gen(function* () {
        const fetcher = yield* makeSqlEventFetcher<string>(
          EventSelection.of({ exactTags: new Map([["marker", marker]]) })
        );
        return yield* fetcher.fetchEvents("proc", 0n, 2);
      })
    );

    assert.strictEqual(rows.length, 2);
  });

  it("snapshot-visibility filter: a fetch never observes a still-uncommitted lower position, even when a higher position has already committed", async () => {
    const marker = crypto.randomUUID();

    const clientA = new Client({
      host: db.connInfo.host,
      port: db.connInfo.port,
      database: db.connInfo.database,
      user: db.connInfo.username,
      password: db.connInfo.password
    });
    const clientB = new Client({
      host: db.connInfo.host,
      port: db.connInfo.port,
      database: db.connInfo.database,
      user: db.connInfo.username,
      password: db.connInfo.password
    });

    try {
      await clientA.connect();
      await clientB.connect();

      // p_tags is TEXT[] where each element is itself a Postgres array-literal STRING
      // (e.g. "{key=value}") representing one event's tag list - matching
      // EventStoreImpl.convertTagsToPostgresArray / this port's encodeTagsLiteral, not a plain
      // "key=value" string.
      await clientA.query("BEGIN");
      await clientA.query(
        "SELECT append_events_batch($1::text[], $2::text[], $3::jsonb[], now())",
        [["GapTestEvent"], [`{marker=${marker}A}`], ["{}"]]
      );
      // txA deliberately left open (uncommitted) - it holds the lower position.

      await clientB.query("BEGIN");
      await clientB.query(
        "SELECT append_events_batch($1::text[], $2::text[], $3::jsonb[], now())",
        [["GapTestEvent"], [`{marker=${marker}B}`], ["{}"]]
      );
      await clientB.query("COMMIT"); // txB commits first, holding the higher position.

      const rowsWhileOpen = await run(
        Effect.gen(function* () {
          const fetcher = yield* makeSqlEventFetcher<string>(
            EventSelection.of({ exactTags: new Map([["marker", `${marker}A`]]) })
          );
          const a = yield* fetcher.fetchEvents("proc", 0n, 1000);
          const fetcherB = yield* makeSqlEventFetcher<string>(
            EventSelection.of({ exactTags: new Map([["marker", `${marker}B`]]) })
          );
          const b = yield* fetcherB.fetchEvents("proc", 0n, 1000);
          return { a, b };
        })
      );
      // Neither row is visible yet: B's row is committed but sits at a higher position than the
      // still-in-flight A, so the snapshot-xmin filter excludes it too - otherwise a poller could
      // advance its cursor past A's position and never pick it up once A commits.
      assert.strictEqual(rowsWhileOpen.a.length, 0);
      assert.strictEqual(rowsWhileOpen.b.length, 0);

      await clientA.query("COMMIT");

      const rowsAfterCommit = await run(
        Effect.gen(function* () {
          const fetcher = yield* makeSqlEventFetcher<string>(
            EventSelection.of({ eventTypes: new Set(["GapTestEvent"]) })
          );
          return yield* fetcher.fetchEvents("proc", 0n, 1000);
        })
      );
      const markersSeen = rowsAfterCommit
        .filter((e) => e.tags.some((t) => t.key === "marker" && t.value.startsWith(marker)))
        .map((e) => e.tags.find((t) => t.key === "marker")!.value)
        .sort();
      assert.deepStrictEqual(markersSeen, [`${marker}A`, `${marker}B`]);
    } finally {
      await clientA.end();
      await clientB.end();
    }
  });
});
