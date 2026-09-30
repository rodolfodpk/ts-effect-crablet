// Runs under Node (Testcontainers) - see NOTES.md.
//
// A writer that is IN FLIGHT (its transaction is open, its events not yet committed) must make a
// checker whose append condition those events would match WAIT for it, and then see it. Otherwise the
// checker's "nothing matches since position p" is answered from a snapshot that cannot yet contain the
// in-flight events, and both commit: a lost conflict. The in-flight writer is held open deterministically
// (its transaction waits on a gate), so there is no timing luck.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive, existsProjector } from "../../src/EventStore.ts";
import * as AppendEvent from "../../src/AppendEvent.ts";
import * as AppendCondition from "../../src/AppendCondition.ts";
import * as Query from "../../src/Query.ts";
import * as Tag from "../../src/Tag.ts";
import * as LogPosition from "../../src/LogPosition.ts";

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

const positionOf = (query: Query.Query) =>
  run(
    Effect.gen(function* () {
      const store = yield* EventStore;
      return (yield* store.project(query, LogPosition.zero(), [existsProjector()])).logPosition;
    })
  );

type Outcome = "ok" | "conflict";
const check = (events: ReadonlyArray<AppendEvent.AppendEvent>, condition: AppendCondition.AppendCondition): Promise<Outcome> =>
  run(
    Effect.gen(function* () {
      const store = yield* EventStore;
      return yield* store.append(events, condition).pipe(
        Effect.map((): Outcome => "ok"),
        Effect.catchTag("Conflict", () => Effect.succeed("conflict" as const))
      );
    })
  );

// Appends `events` inside a transaction that stays open until `release()` is called. Resolves once the
// append has happened (its rows exist but are not committed).
const inFlight = async (events: ReadonlyArray<AppendEvent.AppendEvent>, condition?: AppendCondition.AppendCondition) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let appended!: () => void;
  const appendedP = new Promise<void>((resolve) => (appended = resolve));
  const done = run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* EventStore;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (condition) yield* store.append(events, condition);
          else yield* store.append(events);
          appended();
          yield* Effect.promise(() => gate);
        })
      );
    })
  );
  await Promise.race([appendedP, done]);
  return { release, done };
};

const WAIT_MS = 400;
const settled = <T>(p: Promise<T>): Promise<T | "still waiting"> =>
  Promise.race([p, new Promise<"still waiting">((r) => setTimeout(() => r("still waiting"), WAIT_MS))]);

describe("a checker waits for an in-flight writer whose events match its condition", () => {
  it("unconditional (concurrent) writer in flight: the checker waits, then sees it and conflicts", async () => {
    const id = uid();
    const condition = Query.of([Query.queryItemOf(["WL_X"], [Tag.of("k", id)])]);
    const p0 = await positionOf(condition);

    // the in-flight event carries MORE tags than the condition item and has no condition of its own:
    // it matches the checker's item, but no item is textually shared between the two writers
    const writer = await inFlight([ev("WL_X", ["k", id], ["extra", "1"])]);
    try {
      const checker = check([ev("WL_Y", ["k", id])], AppendCondition.of(p0, condition));
      const early = await settled(checker);
      assert.equal(early, "still waiting", `the checker ran past an in-flight writer it conflicts with (got "${early}")`);
      writer.release();
      await writer.done;
      assert.equal(await checker, "conflict", "after the writer commits, the checker must see it");
    } finally {
      writer.release();
    }
  });

  it("the in-flight writer has a condition of its own (a different item): same result", async () => {
    const id = uid();
    const other = uid();
    const condition = Query.of([Query.queryItemOf(["WL_X"], [Tag.of("k", id)])]);
    const p0 = await positionOf(condition);
    const writerCondition = AppendCondition.of(LogPosition.zero(), Query.of([Query.queryItemOf(["WL_Z"], [Tag.of("z", other)])]));

    const writer = await inFlight([ev("WL_X", ["k", id])], writerCondition);
    try {
      const checker = check([ev("WL_Y", ["k", id])], AppendCondition.of(p0, condition));
      assert.equal(await settled(checker), "still waiting");
      writer.release();
      await writer.done;
      assert.equal(await checker, "conflict");
    } finally {
      writer.release();
    }
  });

  it("no false serialization: an in-flight writer whose events cannot match does not delay the checker", async () => {
    const id = uid();
    const condition = Query.of([Query.queryItemOf(["WL_X"], [Tag.of("k", id)])]);
    const p0 = await positionOf(condition);

    const writer = await inFlight([ev("WL_X", ["k", uid()])]); // same type, different tag value
    const sameTagOtherType = await inFlight([ev("WL_OTHER", ["k", id])]); // same tag, different type
    try {
      assert.equal(await settled(check([ev("WL_Y", ["k", id])], AppendCondition.of(p0, condition))), "ok");
    } finally {
      writer.release();
      sameTagOtherType.release();
    }
  });
});
