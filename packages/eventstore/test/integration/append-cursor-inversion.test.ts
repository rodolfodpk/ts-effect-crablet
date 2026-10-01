// Runs under Node (Testcontainers) - see NOTES.md.
//
// Phase 1 of docs/plans/poller-cursor-fix.md: does the append condition's cursor have the same
// out-of-order position/xid hole as the poller's? The conflict check is
// `position > afterPosition AND transaction_id < xmin`, and `afterPosition` is the position of the last
// event the decision model loaded.
//
// Setup (T1 and T2 are writers of two different event TYPES of the command's boundary - the usual shape of a
// decision model. Writers lock their own (type, tag) pairs, so writers of different types do not serialize
// against each other; here they are raw connections):
//   T1 takes the lower xid; T2 reserves a position (and so takes the higher xid) and stays open;
//   T1 inserts an event of the boundary (position above T2's) and commits - visible, because xmin is T2's xid.
//   The command loads its model: it sees T1's event; its cursor is T1's position.
//   T2 inserts its event of the boundary at its LOWER position and commits.
//   The command appends. T2's event matches its boundary and was committed before the append, but the
//   command never saw it. A correct condition reports a Conflict.
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

const connect = async (): Promise<Client> => {
  const c = new Client({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    user: db.connInfo.username,
    password: db.connInfo.password
  });
  await c.connect();
  return c;
};

describe("append condition cursor vs. out-of-order position/xid", () => {
  it("an event of the boundary committed with a lower position than the loaded cursor is still a conflict", async () => {
    const id = crypto.randomUUID();
    const query = Query.forEventsAndTags(["DcbInvX", "DcbInvY"], [Tag.of("k", id)]);
    const t1 = await connect();
    const t2 = await connect();
    try {
      await t1.query("BEGIN");
      await t1.query("SELECT pg_current_xact_id()");
      await t2.query("BEGIN");
      const p2 = (await t2.query("SELECT nextval('crablet_events_position_seq') AS p")).rows[0].p as string;

      await t1.query(
        `INSERT INTO crablet_events (type, tags, data, transaction_id)
         VALUES ('DcbInvX', ARRAY['k=${id}'], '{}'::jsonb, pg_current_xact_id())`
      );
      await t1.query("COMMIT");

      // The command loads its model now: T1's event is visible (T2 is still open), T2's does not exist yet.
      const loaded = await run(
        Effect.gen(function* () {
          const store = yield* EventStore;
          return (yield* store.project(query, LogPosition.zero(), [existsProjector()])).logPosition;
        })
      );
      assert.ok(loaded.position > BigInt(p2), "the command's cursor is above T2's reserved position");

      await t2.query(
        `INSERT INTO crablet_events (position, type, tags, data, transaction_id)
         VALUES ($1, 'DcbInvY', ARRAY['k=${id}'], '{}'::jsonb, pg_current_xact_id())`,
        [p2]
      );
      await t2.query("COMMIT");

      // Committed before this append, in the boundary, never seen by the command: must be a Conflict.
      const outcome = await run(
        Effect.gen(function* () {
          const store = yield* EventStore;
          return yield* store
            .append(
              [AppendEvent.builder("DcbInvDecision").tags([Tag.of("k", id)]).data({}).build()],
              AppendCondition.failIfChanged(query).after(loaded)
            )
            .pipe(
              Effect.map(() => "ok" as const),
              Effect.catchTag("Conflict", () => Effect.succeed("conflict" as const))
            );
        })
      );
      assert.equal(outcome, "conflict");
    } finally {
      await t1.end();
      await t2.end();
    }
  });

  it("an event the command loaded before it settled is reported as a conflict; the reload settles it and the retry succeeds", async () => {
    const id = crypto.randomUUID();
    const query = Query.forEventAndTag("DcbSettle", "k", id);
    const open = await connect();
    try {
      // An unrelated transaction with a LOWER xid stays open, so xmin stays below the next event's xid.
      await open.query("BEGIN");
      await open.query("SELECT pg_current_xact_id()");
      await run(
        Effect.flatMap(EventStore, (s) =>
          s.append([AppendEvent.builder("DcbSettle").tags([Tag.of("k", id)]).data({}).build()])
        )
      );

      const load = () =>
        run(
          Effect.gen(function* () {
            const store = yield* EventStore;
            return (yield* store.project(query, LogPosition.zero(), [existsProjector()])).logPosition;
          })
        );
      const decide = (cursor: Awaited<ReturnType<typeof load>>) =>
        run(
          Effect.gen(function* () {
            const store = yield* EventStore;
            return yield* store
              .append(
                [AppendEvent.builder("DcbSettleDecision").tags([Tag.of("k", id)]).data({}).build()],
                AppendCondition.failIfChanged(query).after(cursor)
              )
              .pipe(
                Effect.map(() => "ok" as const),
                Effect.catchTag("Conflict", () => Effect.succeed("conflict" as const))
              );
          })
        );

      const unsettled = await load(); // saw the event, but its transaction was newer than the oldest open one
      await open.query("COMMIT"); // now it is settled
      assert.equal(await decide(unsettled), "conflict"); // safe: the command retries
      assert.equal(await decide(await load()), "ok"); // the reload's cursor covers it
    } finally {
      await open.end();
    }
  });
});
