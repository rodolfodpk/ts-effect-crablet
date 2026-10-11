// Runs under Node (Testcontainers). A view declared with `defineView` (ADR-0026): the SQL its operations compile to does what the in-memory run says it does,
// a batch handled twice is applied once, and the declared tables are compared with the migrated database.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive, type StoredEvent } from "@crablet/eventstore";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import { EventDecodingError } from "@crablet/eventstore/EventDecoding";
import { defineView, type ViewEvent } from "../../src/ProjectedView.ts";
import { makeViewsProcessor } from "../../src/ViewsModule.ts";
import { applyInMemory, normalizeRow, rowsOf } from "../../src/ViewMemory.ts";
import { checkViewTables } from "../../src/ViewTableCheck.ts";
import { bigint, decimal, integer, text, timestamptz, viewTable } from "../../src/ViewTable.ts";
import type { ViewsConfig } from "../../src/ViewsConfig.ts";

type Env = EventStore | SqlClient.SqlClient | PgClient.PgClient;
let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<Env, never>;

const accounts = viewTable("pv_accounts", {
  key: { id: text() },
  columns: { balance: decimal().default(0), deposits: integer().default(0), note: text().nullable(), last_at: timestamptz().nullable() }
});
const moves = viewTable("pv_moves", {
  key: { move_id: text(), event_position: bigint() },
  columns: { account_id: text(), amount: decimal() }
});

const eventOf = <D>(type: string): ViewEvent<D> => ({
  type,
  decodeStored: (event) =>
    Effect.succeed(event.data as D).pipe(
      Effect.filterOrFail(
        (d) => typeof d === "object" && d !== null,
        () => new EventDecodingError({ message: "cannot be read", type, position: event.position, transactionId: event.transactionId, issues: [] })
      )
    )
});
const Opened = eventOf<{ id: string; balance: number; note: string }>("PvOpened");
const Deposited = eventOf<{ id: string; moveId: string; amount: number; at: string }>("PvDeposited");
const Withdrawn = eventOf<{ id: string; moveId: string; amount: number; at: string }>("PvWithdrawn");
const Noted = eventOf<{ id: string; note: string | null }>("PvNoted");
const Closed = eventOf<{ id: string }>("PvClosed");

const view = defineView("pv-accounts", { tables: [accounts, moves] })
  .on(Opened, (d) => accounts.insert({ id: d.id, balance: d.balance, note: d.note }, { onConflict: "replace" }))
  .on(Deposited, (d, ctx) => [
    accounts.upsert({ id: d.id }, { add: { balance: d.amount, deposits: 1 }, max: { last_at: d.at } }),
    moves.insert({ move_id: d.moveId, event_position: ctx.position, account_id: d.id, amount: d.amount }, { onConflict: "ignore" })
  ])
  .on(Withdrawn, (d) => accounts.update({ id: d.id }, { add: { balance: -d.amount }, max: { last_at: d.at } }))
  .on(Noted, (d) => accounts.update({ id: d.id }, { set: { note: d.note } }))
  .on(Closed, (d) => accounts.remove({ id: d.id }));

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
  runtime = ManagedRuntime.make(Layer.provideMerge(EventStoreLive, pgLayer) as unknown as Layer.Layer<Env, never>);
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`CREATE TABLE pv_accounts (id text PRIMARY KEY, balance numeric(19,2) NOT NULL DEFAULT 0, deposits integer NOT NULL DEFAULT 0, note text, last_at timestamptz)`);
      yield* sql.unsafe(`CREATE TABLE pv_moves (move_id text NOT NULL, event_position bigint NOT NULL, account_id text NOT NULL, amount numeric(19,2) NOT NULL, PRIMARY KEY (move_id, event_position))`);
      // Test-only fault injection, as in view-exactly-once.test.ts: moving this view's cursor fails while a row for it is in pv_fail.
      yield* sql.unsafe("CREATE TABLE pv_fail (view_name text PRIMARY KEY)");
      yield* sql.unsafe(`CREATE FUNCTION pv_fail_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pv_fail WHERE view_name = NEW.view_name) THEN RAISE EXCEPTION 'injected: cursor update failed'; END IF;
          RETURN NEW;
        END $$`);
      yield* sql.unsafe(`CREATE TRIGGER pv_fail_cursor BEFORE UPDATE ON crablet_view_progress FOR EACH ROW
        WHEN (OLD.last_position IS DISTINCT FROM NEW.last_position) EXECUTE FUNCTION pv_fail_cursor()`);
    })
  );
}, { timeout: 60_000 });

after(async () => {
  await runtime.dispose();
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, Env>) => runtime.runPromise(effect);

let position = 0n;
const stored = (type: string, data: unknown): StoredEvent => ({ type, data, position: ++position, transactionId: "1", tags: [], correlationId: null }) as unknown as StoredEvent;

const history = (): ReadonlyArray<StoredEvent> => [
  stored("PvDeposited", { id: "a", moveId: "m1", amount: 5, at: "2026-01-02T00:00:00Z" }), // a row made by an upsert, from defaults
  stored("PvOpened", { id: "a", balance: 100, note: "first" }), // replace: balance and note, not deposits
  stored("PvDeposited", { id: "a", moveId: "m2", amount: 7, at: "2026-01-01T00:00:00Z" }), // an earlier instant does not move last_at back
  stored("PvWithdrawn", { id: "a", moveId: "w1", amount: 20, at: "2026-01-03T00:00:00Z" }),
  stored("PvWithdrawn", { id: "ghost", moveId: "w2", amount: 1, at: "2026-01-03T00:00:00Z" }), // no row: nothing happens
  stored("PvOpened", { id: "b", balance: 1, note: "b" }),
  stored("PvNoted", { id: "b", note: null }),
  stored("PvClosed", { id: "b" }),
  stored("PvDeposited", { id: "b", moveId: "m3", amount: 4, at: "2026-02-01T00:00:00Z" }), // a closed wallet's row comes back from defaults
  stored("PvOpened", { id: "c", balance: 3, note: "c" })
];

const rowsFromPostgres = (table: typeof accounts | typeof moves, order: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM ${table.name} ORDER BY ${order}`);
    return rows.map((r) => normalizeRow(table, r));
  });

describe("a declared view on real Postgres", () => {
  it("the SQL leaves the rows the in-memory run says it should", async () => {
    const events = history();
    const memory = await run(applyInMemory(view, events));
    await run(Effect.flatMap(view.projector, (p) => p.handle(events)));

    const pgAccounts = await run(rowsFromPostgres(accounts, "id"));
    assert.deepStrictEqual(pgAccounts, rowsOf(memory, accounts));
    assert.deepStrictEqual(await run(rowsFromPostgres(moves, "move_id")), rowsOf(memory, moves).slice().sort((x, y) => String(x["move_id"]).localeCompare(String(y["move_id"]))));
    // And the rows are what the history means, not only equal to each other.
    const a = pgAccounts.find((r) => r["id"] === "a")!;
    assert.deepStrictEqual({ balance: a["balance"], deposits: a["deposits"], note: a["note"], last_at: a["last_at"] }, { balance: 87, deposits: 2, note: "first", last_at: Date.parse("2026-01-03T00:00:00Z") });
    assert.ok(pgAccounts.some((r) => r["id"] === "b" && r["balance"] === 4 && r["note"] === null), "a closed wallet that gets a deposit starts again from the defaults");
  });

  it("a batch that comes through the processor twice (a crash between the view's commit and the cursor) is applied once", { timeout: 30_000 }, async () => {
    const counter = defineView("pv-once", { tables: [accounts] })
      .on(Deposited, (d) => accounts.upsert({ id: `once-${d.id}` }, { add: { balance: d.amount, deposits: 1 } }));
    const config: ViewsConfig = { enabled: true, pollingIntervalMs: 100, batchSize: 100, backoffEnabled: false, backoffThreshold: 3, backoffMultiplier: 2, backoffMaxSeconds: 120, leaderElectionRetryIntervalMs: 30_000, maxErrors: 5 };
    await run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        for (const amount of [5, 7]) yield* store.append([AppendEvent.ofUntagged("PvDeposited", { id: "x", moveId: `once-${amount}`, amount, at: "2026-01-01T00:00:00Z" })]);
      })
    );
    const handle = await run(
      Effect.gen(function* () {
        return yield* makeViewsProcessor({ config, projectors: [yield* counter.projector], subscriptions: [counter.subscription()], instanceId: `instance-${crypto.randomUUID()}` });
      })
    );
    await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("INSERT INTO pv_fail (view_name) VALUES ('pv-once')")));
    const first = await run(Effect.exit(handle.service.process("pv-once")));
    assert.strictEqual(first._tag, "Failure", "the cursor update was made to fail, after the view's write");
    await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("DELETE FROM pv_fail WHERE view_name = 'pv-once'")));
    await run(handle.service.process("pv-once")); // the retry, as the next tick does it

    const row = (await run(rowsFromPostgres(accounts, "id"))).find((r) => r["id"] === "once-x")!;
    assert.deepStrictEqual({ balance: row["balance"], deposits: row["deposits"] }, { balance: 12, deposits: 2 }, "5 + 7 once; 24 means the batch was applied twice");
  });
});

describe("checkViewTables", () => {
  it("finds nothing when the declarations match the migrated tables", async () => {
    assert.deepStrictEqual(await run(Effect.flatMap(SqlClient.SqlClient, (sql) => checkViewTables(sql, [accounts, moves]))), []);
  });

  it("names a missing table, a missing column, a wrong type, a wrong nullability, a missing default, a wrong key and a column the code does not know", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("CREATE TABLE pv_drift (id text, qty bigint NOT NULL, label text NOT NULL, total numeric, extra text NOT NULL)");
      })
    );
    const drift = viewTable("pv_drift", {
      key: { id: text() },
      columns: { qty: integer(), label: text().nullable(), total: decimal().default(0), gone: text() }
    });
    const missing = viewTable("pv_missing", { key: { id: text() }, columns: {} });
    const problems = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => checkViewTables(sql, [drift, missing])));
    assert.deepStrictEqual(problems.slice().sort(), [
      "pv_drift.extra: NOT NULL without a default in the database, not declared",
      "pv_drift.gone: the column does not exist",
      "pv_drift.id: declared NOT NULL, the database has nullable",
      "pv_drift.label: declared nullable, the database has NOT NULL",
      "pv_drift.qty: declared integer (integer), the database has bigint",
      "pv_drift.total: declared NOT NULL, the database has nullable",
      "pv_drift.total: declared with a default, the database has none",
      "pv_drift: the primary key is () in the database, (id) declared",
      "pv_missing: the table does not exist"
    ]);
  });
});
