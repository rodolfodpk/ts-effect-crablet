// Runs under Node (Testcontainers). DIFFERENTIAL test: random histories of appends (with random
// conditions) and reads are applied, step by step, to the in-memory store AND to real Postgres, and
// every step's result must be identical - append outcomes (ok / conflict / duplicate) and everything a
// read returns (positions, types, tags, data, final position). It finds disagreements nobody thought to
// write a conformance case for. A failure prints the seed and step, so it is exactly reproducible.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "../../src/EventStore.ts";
import { makeInMemoryEventStore } from "../../src/testing/InMemoryEventStore.ts";
import * as AppendCondition from "../../src/AppendCondition.ts";
import * as AppendEvent from "../../src/AppendEvent.ts";
import * as LogPosition from "../../src/LogPosition.ts";
import * as Query from "../../src/Query.ts";
import * as Tag from "../../src/Tag.ts";
import { append, read, type Harness } from "../conformance/ops.ts";

let db: TestDb;
let pg: Harness;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  const layer = Layer.provide(EventStoreLive, pgLayer) as unknown as Layer.Layer<EventStore, never>;
  pg = { run: (effect) => Effect.runPromise(Effect.provide(effect, layer)) };
}, { timeout: 60_000 });

after(async () => {
  await db.stop();
});

// Every seed starts from an EMPTY log with positions restarting at 1, like a fresh in-memory store, so
// the two stores' positions line up step by step.
const resetPostgres = async () => {
  const client = new Client({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    user: db.connInfo.username,
    password: db.connInfo.password
  });
  await client.connect();
  try {
    await client.query("TRUNCATE crablet_events RESTART IDENTITY CASCADE");
  } finally {
    await client.end();
  }
};

// Small deterministic PRNG (mulberry32): same seed, same history.
const prng = (seed: number) => {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: ReadonlyArray<T>): T => xs[int(xs.length)]!;
  const subset = <T>(xs: ReadonlyArray<T>, max: number): Array<T> => {
    const chosen = new Set<T>();
    const count = int(max + 1);
    for (let i = 0; i < count; i++) chosen.add(pick(xs));
    return [...chosen];
  };
  return { next, int, pick, subset };
};

// A deliberately SMALL vocabulary so that random events, queries and conditions collide often.
const TYPES = ["A", "B", "C"] as const;
const TAGS: ReadonlyArray<readonly [string, string]> = [
  ["k", "x"], ["k", "y"], ["j", "x"], ["j", "z"], ["k", "a,b"], ["j", 'q"r']
];

type Rng = ReturnType<typeof prng>;
const randomItem = (r: Rng) =>
  Query.queryItemOf(r.subset(TYPES, 2), r.subset(TAGS, 2).map(([k, v]) => Tag.of(k, v)));
const randomQuery = (r: Rng) => Query.of(Array.from({ length: r.int(4) }, () => randomItem(r)));

// What the random histories actually exercised, so the test cannot pass vacuously.
const seen = { ok: 0, conflict: 0, duplicate: 0, conditional: 0, readsWithResults: 0, reads: 0 };

describe("differential: in-memory vs Postgres", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}: 150 random steps agree exactly`, { timeout: 120_000 }, async () => {
      await resetPostgres();
      const mem = makeInMemoryEventStore();
      const memH: Harness = { run: (effect) => Effect.runPromise(Effect.provide(effect, mem.layer)) };
      const r = prng(seed);
      // Both stores are fresh and identical, so positions line up; this tracks the newest one.
      let head = 0n;

      for (let step = 1; step <= 150; step++) {
        const where = `seed ${seed}, step ${step}`;
        if (r.next() < 0.65) {
          const events = Array.from({ length: 1 + r.int(3) }, () =>
            AppendEvent.builder(r.pick(TYPES))
              .tags(r.subset(TAGS, 2).map(([k, v]) => Tag.of(k, v)))
              .data({ step })
              .build()
          );
          const condition =
            r.next() < 0.6
              ? AppendCondition.of(
                  LogPosition.of(BigInt(r.int(Number(head) + 1)), new Date(0), "0"),
                  r.next() < 0.75 ? randomQuery(r) : Query.noCondition(),
                  r.next() < 0.4 ? randomQuery(r) : Query.noCondition()
                )
              : undefined;
          const expected = await append(memH, events, condition);
          const actual = await append(pg, events, condition);
          assert.equal(actual, expected, `${where}: append outcome differs (postgres=${actual}, in-memory=${expected})`);
          seen[actual] += 1;
          if (condition !== undefined) seen.conditional += 1;
          if (actual === "ok") head += BigInt(events.length);
        } else {
          const query = randomQuery(r);
          const after = LogPosition.of(BigInt(r.int(Number(head) + 1)), new Date(0), "0");
          const summarize = (x: Awaited<ReturnType<typeof read>>) => ({
            position: x.logPosition.position,
            events: x.state.map((e) => [e.position, e.type, e.tags.map((t) => `${t.key}=${t.value}`).sort(), e.data])
          });
          const fromPostgres = summarize(await read(pg, query, after));
          assert.deepEqual(fromPostgres, summarize(await read(memH, query, after)), `${where}: read differs`);
          seen.reads += 1;
          if (fromPostgres.events.length > 0) seen.readsWithResults += 1;
        }
      }
      // and the whole logs are identical
      assert.deepEqual(
        (await read(pg, Query.of([]))).state.map((e) => [e.position, e.type, e.data]),
        (await read(memH, Query.of([]))).state.map((e) => [e.position, e.type, e.data])
      );
    });
  }

  it("the random histories exercised every outcome (the comparison is not vacuous)", () => {
    console.log(`[differential] ${JSON.stringify(seen)}`);
    assert.ok(seen.ok >= 100, `too few accepted appends: ${seen.ok}`);
    assert.ok(seen.conflict >= 20, `too few conflicts: ${seen.conflict}`);
    assert.ok(seen.duplicate >= 20, `too few duplicates: ${seen.duplicate}`);
    assert.ok(seen.readsWithResults >= 100, `too few reads with results: ${seen.readsWithResults}`);
  });
});
