// Runs under Node (Testcontainers) - see NOTES.md.
// Probabilistic smoke for docs/plans/poller-cursor-fix.md: many concurrent writers (different tags, so the writer
// locks do not serialize them) while a reader polls with the (transaction_id, position) cursor. It cannot prove
// the absence of a skip on its own - cursor-inversion.test.ts is the deterministic gate - but with a bare position
// cursor this shape lost a few events per few thousand appends.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { makeSqlEventFetcher } from "../../src/SqlEventFetcher.ts";
import * as EventSelection from "../../src/EventSelection.ts";
import * as ProgressCursorNS from "../../src/ProgressCursor.ts";

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<EventStore | SqlClient.SqlClient, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password),
    maxConnections: 24
  });
  runtime = ManagedRuntime.make(
    Layer.provideMerge(EventStoreLive, pgLayer) as unknown as Layer.Layer<EventStore | SqlClient.SqlClient, never>
  );
}, { timeout: 60_000 });

after(async () => {
  await runtime.dispose();
  await db.stop();
});

const WRITERS = 8;
const PER_WRITER = 250;

describe("poller cursor under concurrent writers", () => {
  it(`delivers every one of ${WRITERS * PER_WRITER} events appended by ${WRITERS} concurrent writers`, { timeout: 120_000 }, async () => {
    const delivered = new Set<bigint>();
    let writing = true;

    const reader = (async () => {
      let cursor = ProgressCursorNS.zero;
      let idleRoundsAfterWriting = 0;
      while (idleRoundsAfterWriting < 3) {
        const batch = await runtime.runPromise(
          Effect.gen(function* () {
            const fetcher = yield* makeSqlEventFetcher<string>(EventSelection.of({ eventTypes: new Set(["ConcurrentSmoke"]) }));
            return yield* fetcher.fetchEvents("smoke", cursor, 50);
          })
        );
        for (const e of batch) delivered.add(e.position);
        if (batch.length > 0) cursor = ProgressCursorNS.after(batch[batch.length - 1]!);
        else {
          if (!writing) idleRoundsAfterWriting++;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    })();

    const writer = async (w: number) => {
      for (let i = 0; i < PER_WRITER; i++) {
        await runtime.runPromise(
          Effect.flatMap(EventStore, (store) =>
            store.append([AppendEvent.of("ConcurrentSmoke", "writer", `${w}-${i}`, {})])
          )
        );
      }
    };
    await Promise.all(Array.from({ length: WRITERS }, (_, w) => writer(w)));
    writing = false;
    await reader;

    const written = await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe<{ position: string }>("SELECT position::text AS position FROM crablet_events WHERE type = 'ConcurrentSmoke'")
      )
    );
    const missed = written.filter((r) => !delivered.has(BigInt(r.position)));
    assert.equal(written.length, WRITERS * PER_WRITER);
    assert.equal(missed.length, 0, `${missed.length} events were never delivered`);
  });
});
