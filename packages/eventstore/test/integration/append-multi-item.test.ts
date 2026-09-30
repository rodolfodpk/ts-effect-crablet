// Runs under Node (Testcontainers) - see NOTES.md.
//
// Regression tests for append conditions built from MULTI-ITEM queries. A Query is an OR of items;
// each item is (any-of event types) AND (all tags). The append check must honour that shape:
// a conflicting event matching ANY single item is a conflict, and an event that mixes one item's
// type with another item's tags is NOT.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive, existsProjector } from "../../src/EventStore.ts";
import * as AppendEvent from "../../src/AppendEvent.ts";
import * as AppendCondition from "../../src/AppendCondition.ts";
import * as Query from "../../src/Query.ts";
import * as Tag from "../../src/Tag.ts";
import * as LogPosition from "../../src/LogPosition.ts";
import type { LogPosition as LogPositionType } from "../../src/LogPosition.ts";

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
  layer = Layer.provideMerge(EventStoreLive, pgLayer) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient, never>;
}, { timeout: 60_000 });

after(async () => {
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, EventStore | SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

const uid = () => crypto.randomUUID();
const ev = (type: string, ...tags: Array<[string, string]>) =>
  AppendEvent.builder(type).tags(tags.map(([k, v]) => Tag.of(k, v))).data({ n: 1 }).build();

// Position of the newest event matching `query` (zero when none).
const positionOf = (query: Query.Query): Promise<LogPositionType> =>
  run(
    Effect.gen(function* () {
      const store = yield* EventStore;
      return (yield* store.project(query, LogPosition.zero(), [existsProjector()])).logPosition;
    })
  );

type Outcome = "ok" | "DCB_VIOLATION" | "IDEMPOTENCY_VIOLATION" | `other:${string}`;
const attempt = (events: ReadonlyArray<AppendEvent.AppendEvent>, condition: AppendCondition.AppendCondition): Promise<Outcome> =>
  run(
    Effect.gen(function* () {
      const store = yield* EventStore;
      return yield* store.appendConditional(events, condition).pipe(
        Effect.map((): Outcome => "ok"),
        Effect.catchTag("ConcurrencyException", (e) =>
          Effect.succeed((e.violation?.errorCode ?? `other:${e.message}`) as Outcome)
        )
      );
    })
  );

// Two-item query: item A = (TypeA, k=id), item B = (TypeB, j=id).
const twoItems = (id: string) =>
  Query.of([
    Query.queryItemOf(["MI_A"], [Tag.of("k", id)]),
    Query.queryItemOf(["MI_B"], [Tag.of("j", id)])
  ]);

describe("append conditions with multi-item queries", () => {
  it("concurrency: an event matching only the SECOND item is a conflict", async () => {
    const id = uid();
    await run(Effect.flatMap(EventStore, (s) => s.appendCommutative([ev("MI_A", ["k", id])])));
    const q = twoItems(id);
    const p0 = await positionOf(q);

    // conflicting event matches item B only
    await run(Effect.flatMap(EventStore, (s) => s.appendCommutative([ev("MI_B", ["j", id])])));

    const outcome = await attempt([ev("MI_Other", ["z", id])], AppendCondition.of(p0, q));
    assert.equal(outcome, "DCB_VIOLATION");
  });

  it("concurrency: an event matching only the FIRST item is a conflict", async () => {
    const id = uid();
    await run(Effect.flatMap(EventStore, (s) => s.appendCommutative([ev("MI_B", ["j", id])])));
    const q = twoItems(id);
    const p0 = await positionOf(q);
    await run(Effect.flatMap(EventStore, (s) => s.appendCommutative([ev("MI_A", ["k", id])])));
    assert.equal(await attempt([ev("MI_Other", ["z", id])], AppendCondition.of(p0, q)), "DCB_VIOLATION");
  });

  it("concurrency: no matching event after the position -> succeeds (no false positive)", async () => {
    const id = uid();
    await run(Effect.flatMap(EventStore, (s) => s.appendCommutative([ev("MI_A", ["k", id]), ev("MI_B", ["j", id])])));
    const q = twoItems(id);
    const p = await positionOf(q); // already includes both events
    assert.equal(await attempt([ev("MI_Other", ["z", id])], AppendCondition.of(p, q)), "ok");
  });

  it("concurrency: an event mixing one item's type with ANOTHER item's tags does NOT match", async () => {
    const id = uid();
    const q = twoItems(id);
    const p0 = await positionOf(q);
    // TypeA but carrying item B's tag: satisfies neither item
    await run(Effect.flatMap(EventStore, (s) => s.appendCommutative([ev("MI_A", ["j", id])])));
    assert.equal(await attempt([ev("MI_Other", ["z", id])], AppendCondition.of(p0, q)), "ok");
  });

  it("concurrency: N racers with the SAME start position and multi-item condition -> exactly one wins", async () => {
    const id = uid();
    const q = twoItems(id);
    const p0 = await positionOf(q); // everyone decided on the same (empty) state
    const racers = 8;
    const outcomes = await run(
      Effect.all(
        Array.from({ length: racers }, (_, i) =>
          Effect.promise(() =>
            // each racer appends an event that matches the shared condition (alternating items)
            attempt([i % 2 === 0 ? ev("MI_A", ["k", id]) : ev("MI_B", ["j", id])], AppendCondition.of(p0, q))
          )
        ),
        { concurrency: racers }
      )
    );
    const wins = outcomes.filter((o) => o === "ok").length;
    assert.equal(wins, 1, `exactly one racer may win, got ${JSON.stringify(outcomes)}`);
  });

  it("concurrency: commands with OVERLAPPING but different conditions serialize on their shared items", async () => {
    // Mirrors "withdraw on wallet A" vs "transfer from A to B": B's condition is A's plus more items.
    const rounds = 15;
    let bothWon = 0;
    for (let round = 0; round < rounds; round++) {
      const id = uid();
      const other = uid();
      const qA = twoItems(id); // items: (MI_A,k=id) | (MI_B,j=id)
      const qB = Query.of([...qA.items, Query.queryItemOf(["MI_C"], [Tag.of("m", other)])]); // superset
      const p0 = await positionOf(qB);
      const outcomes = await run(
        Effect.all(
          [
            // each racer's event matches the OTHER racer's condition
            Effect.promise(() => attempt([ev("MI_A", ["k", id])], AppendCondition.of(p0, qA))),
            Effect.promise(() => attempt([ev("MI_B", ["j", id])], AppendCondition.of(p0, qB)))
          ],
          { concurrency: 2 }
        )
      );
      if (outcomes.every((o) => o === "ok")) bothWon++;
    }
    assert.equal(bothWon, 0, `both racers won in ${bothWon}/${rounds} rounds`);
  });

  it("idempotency: a duplicate matching only the SECOND idempotency item is detected", async () => {
    const id = uid();
    await run(Effect.flatMap(EventStore, (s) => s.appendCommutative([ev("MI_Done", ["op", id])])));
    const idem = Query.of([
      Query.queryItemOf(["MI_Done"], [Tag.of("op", uid())]), // different op: no match
      Query.queryItemOf(["MI_Done"], [Tag.of("op", id)]) // the duplicate
    ]);
    const outcome = await attempt([ev("MI_Done", ["op", id])], AppendCondition.of(LogPosition.zero(), Query.noCondition(), idem));
    assert.equal(outcome, "IDEMPOTENCY_VIOLATION");
  });

  it("idempotency: no item matches -> succeeds", async () => {
    const idem = Query.of([
      Query.queryItemOf(["MI_Done"], [Tag.of("op", uid())]),
      Query.queryItemOf(["MI_Done"], [Tag.of("op", uid())])
    ]);
    const outcome = await attempt([ev("MI_Done", ["op", uid()])], AppendCondition.of(LogPosition.zero(), Query.noCondition(), idem));
    assert.equal(outcome, "ok");
  });
});

describe("conflict detection must not depend on unrelated open transactions", () => {
  it("a long-running unrelated transaction does not hide a committed conflicting event", async () => {
    const id = uid();
    const q = Query.of(Query.queryItemOf(["MI_A"], [Tag.of("k", id)]));
    const p0 = await positionOf(q);

    // An unrelated session holds a transaction open (with an assigned xid) the whole time.
    const idle = new Client({
      host: db.connInfo.host,
      port: db.connInfo.port,
      database: db.connInfo.database,
      user: db.connInfo.username,
      password: db.connInfo.password
    });
    await idle.connect();
    try {
      await idle.query("BEGIN");
      await idle.query("SELECT pg_current_xact_id()"); // assigns an xid, pinning the snapshot xmin

      // A conflicting event is committed AFTER the idle transaction started.
      await run(Effect.flatMap(EventStore, (s) => s.appendCommutative([ev("MI_A", ["k", id])])));

      const outcome = await attempt([ev("MI_Other", ["z", id])], AppendCondition.of(p0, q));
      assert.equal(outcome, "DCB_VIOLATION", "committed conflicting event must be visible to the check");
    } finally {
      await idle.query("ROLLBACK");
      await idle.end();
    }
  });
});
