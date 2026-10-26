// Runs under Node (Testcontainers). The deadlines processor (ADR-0043) against real Postgres: the append writes the deadline's row, the processor fires
// it when it is due (by the real clock, with short due times), records how it ended, and fails over like any module.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DateTime, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import * as Schema from "effect/Schema";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive, type StoredEvent } from "@crablet/eventstore";
import { CommandAuditStore, CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import { DEADLINES_LOCK_KEY } from "@crablet/eventstore/Leader";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { byModel, deadline, defineCommand, defineEvent, defineModel, DomainError, emit, fail, Instant, noop } from "@crablet/commands/Domain";
import { DeadlineFired } from "@crablet/commands/Deadline";
import { DEADLINES_PROCESSOR_ID, makeDeadlinesProcessor, type DeadlinesConfig } from "../../src/DeadlinesModule.ts";
import { makeDeadlinesManagementService } from "../../src/DeadlinesManagementService.ts";
import { makeDeadlineEventHandler } from "../../src/internal/DeadlineEventHandler.ts";
import type { HandledPrefix } from "@crablet/event-poller/EventHandler";
import { makeDeadlineFetcher, makeRecordFiring } from "../../src/internal/DeadlineStore.ts";

type Services = CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient | PgClient.PgClient;
let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<Services, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
  runtime = ManagedRuntime.make(Layer.provideMerge(Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive), pgLayer) as unknown as Layer.Layer<Services, never>);
}, { timeout: 60_000 });

after(async () => {
  await runtime.dispose();
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);
const query = <T extends object>(text: string, params: ReadonlyArray<unknown> = []) => run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<T>(text, params as Array<unknown>)));
const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}; last: ${JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

// A seat held for a while, given back by a deadline unless it was bought.
const Held = defineEvent("DlpHeld", { schema: Schema.Struct({ seatId: Schema.String, heldAt: Instant }), tags: (d) => ({ seat_id: d.seatId }) });
const Released = defineEvent("DlpReleased", { schema: Schema.Struct({ seatId: Schema.String }), tags: (d) => ({ seat_id: d.seatId }) });
const Bought = defineEvent("DlpBought", { schema: Schema.Struct({ seatId: Schema.String }), tags: (d) => ({ seat_id: d.seatId }) });
const Seat = defineModel({ by: "seat_id", initial: () => ({ status: "never_held" as "never_held" | "held" | "released" | "bought" }) })
  .on(Held, () => ({ status: "held" as const }))
  .on(Released, () => ({ status: "released" as const }))
  .on(Bought, () => ({ status: "bought" as const }));
class NeverHeld extends DomainError("DlpNeverHeld", { fields: { seatId: Schema.String }, kind: "not_found" }) {}

const ReleaseSeat = defineCommand({
  name: "dlp_release_seat",
  input: Schema.Struct({ seatId: Schema.String }),
  errors: [NeverHeld],
  model: (c) => Seat.of({ id: c.seatId }),
  idempotentBy: byModel(),
  decide: (s, c) =>
    s.status === "bought" ? noop("BOUGHT") : s.status === "released" ? noop("ALREADY_RELEASED") : s.status === "never_held" ? fail(new NeverHeld(c)) : emit(Released(c))
});
const Hold = defineCommand({
  name: "dlp_hold_seat",
  input: Schema.Struct({ seatId: Schema.String, forMs: Schema.Number }),
  model: (c) => Seat.of({ id: c.seatId }),
  idempotentBy: byModel(),
  decide: (s, c, { now }) =>
    s.status === "held" || s.status === "bought"
      ? noop("NOT_FREE")
      : emit(Held({ seatId: c.seatId, heldAt: now }), deadline(ReleaseSeat, { seatId: c.seatId }, { at: DateTime.add(now, { milliseconds: c.forMs }) }))
});
const Buy = defineCommand({
  name: "dlp_buy_seat",
  input: Schema.Struct({ seatId: Schema.String }),
  model: (c) => Seat.of({ id: c.seatId }),
  idempotentBy: byModel(),
  decide: (s, c) => (s.status === "bought" ? noop("ALREADY_BOUGHT") : emit(Bought(c)))
});

const config: DeadlinesConfig = { pollingIntervalMs: 100, leaderElectionRetryIntervalMs: 200, maxErrors: 2 };
const exec = (command: typeof Hold | typeof Buy, input: Record<string, unknown>) =>
  run(Effect.flatMap(CommandExecutor, (executor) => executor.run(command as typeof Hold, input as never)));
const seat = () => `seat-${crypto.randomUUID()}`;

interface EventRow { readonly position: string; readonly type: string; readonly data: Record<string, unknown>; readonly causation_id: string | null }
const eventsOf = (seatId: string) =>
  query<EventRow & { readonly marker: string }>(
    "SELECT position::text AS position, type, data, causation_id::text AS causation_id, transaction_id::text || ':' || position::text AS marker FROM crablet_events WHERE tags @> ARRAY[$1::text] ORDER BY transaction_id, position",
    [`seat_id=${seatId}`]
  );
// The deadline set by holding this seat (it has no tags: found by its input).
const deadlineOf = async (seatId: string) =>
  (await query<EventRow>("SELECT position::text AS position, type, data, causation_id::text AS causation_id FROM crablet_events WHERE type = 'crablet.DeadlineScheduled' AND data -> 'input' ->> 'seatId' = $1", [seatId]))[0];
const firedFor = (position: string) =>
  query<EventRow>("SELECT position::text AS position, type, data, causation_id::text AS causation_id FROM crablet_events WHERE type = $1 AND causation_id = $2::bigint", [DeadlineFired.type, position]);
const rowFor = (position: string) => query<{ due_at: Date }>("SELECT due_at FROM crablet_deadlines WHERE deadline_position = $1::bigint", [position]);

const withProcessor = async (body: () => Promise<void>, instanceId = `dl-${crypto.randomUUID()}`) => {
  const handle = await run(makeDeadlinesProcessor({ commands: [ReleaseSeat], config, instanceId }));
  await run(handle.service.start);
  try { await body(); } finally { await run(handle.service.stop); }
};

describe("deadlines against Postgres (ADR-0043)", () => {
  it("the append that stores a deadline writes its row, with its due time; an append that is rolled back writes none", { timeout: 30_000 }, async () => {
    const id = seat();
    await exec(Hold, { seatId: id, forMs: 60_000 });
    const scheduled = (await deadlineOf(id))!;
    const [row] = await rowFor(scheduled.position);
    assert.ok(row !== undefined, "the deadline's row is there, in the same commit as the event");
    assert.strictEqual(row.due_at.toISOString(), scheduled.data["dueAt"]);

    const rolledBack = seat();
    await run(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.withTransaction(Effect.flatMap(EventStore, (store) => Effect.andThen(store.append([deadline(ReleaseSeat, { seatId: rolledBack }, { at: DateTime.nowUnsafe() })]), Effect.fail("rollback"))))
      ).pipe(Effect.catch(() => Effect.void))
    );
    assert.strictEqual(await deadlineOf(rolledBack), undefined);
    assert.deepStrictEqual(await query("SELECT 1 FROM crablet_deadlines d LEFT JOIN crablet_events e ON e.position = d.deadline_position WHERE e.position IS NULL"), []);
  });

  it("a deadline fires at its due time, not before: the command runs caused by it, the row goes, and the firing is recorded", { timeout: 30_000 }, async () => {
    const id = seat();
    await withProcessor(async () => {
      await exec(Hold, { seatId: id, forMs: 2_000 });
      const scheduled = (await deadlineOf(id))!;
      await new Promise((r) => setTimeout(r, 800));
      assert.deepStrictEqual((await eventsOf(id)).map((e) => e.type), ["DlpHeld"], "not fired before its due time");

      const events = await until(() => eventsOf(id), (es) => es.some((e) => e.type === "DlpReleased"), "the seat to be released");
      const released = events.find((e) => e.type === "DlpReleased")!;
      assert.strictEqual(released.causation_id, scheduled.position, "the release is caused by the deadline");
      const fired = await until(() => firedFor(scheduled.position), (f) => f.length === 1, "the firing to be recorded");
      assert.deepStrictEqual(fired[0]!.data, { deadlinePosition: scheduled.position, outcome: "appended", reason: null, marker: released.marker }, "the marker is where the release ended");
      assert.deepStrictEqual(await rowFor(scheduled.position), [], "the row is gone");
    });
  });

  it("a deadline that no longer matters is a noop with its reason; a domain error is recorded as failed, and the processor goes on", { timeout: 30_000 }, async () => {
    const bought = seat();
    const ghost = seat();
    await exec(Hold, { seatId: bought, forMs: 500 });
    await exec(Buy, { seatId: bought });
    await run(Effect.flatMap(EventStore, (store) => store.append([deadline(ReleaseSeat, { seatId: ghost }, { at: DateTime.nowUnsafe() })])));
    await withProcessor(async () => {
      const boughtDeadline = (await deadlineOf(bought))!;
      const ghostDeadline = (await deadlineOf(ghost))!;
      const a = await until(() => firedFor(boughtDeadline.position), (f) => f.length === 1, "the bought seat's deadline");
      const b = await until(() => firedFor(ghostDeadline.position), (f) => f.length === 1, "the ghost seat's deadline");
      const boughtEvents = await eventsOf(bought);
      assert.deepStrictEqual([a[0]!.data["outcome"], a[0]!.data["reason"], a[0]!.data["marker"]], ["noop", "BOUGHT", boughtEvents.at(-1)!.marker], "a noop points at the write its model read last");
      assert.deepStrictEqual([b[0]!.data["outcome"], b[0]!.data["reason"], b[0]!.data["marker"]], ["failed", "DlpNeverHeld", null]);
      assert.deepStrictEqual(boughtEvents.map((e) => e.type), ["DlpHeld", "DlpBought"], "nothing released");
      const [status] = await query<{ status: string }>("SELECT status FROM crablet_deadline_progress WHERE processor_name = $1", [DEADLINES_PROCESSOR_ID]);
      assert.strictEqual(status!.status, "ACTIVE");
    });
  });

  it("a deadline handled twice (a crash before its firing was recorded, or a zombie and its successor) has one effect and one firing", { timeout: 30_000 }, async () => {
    const id = seat();
    await exec(Hold, { seatId: id, forMs: 0 });
    const scheduled = (await deadlineOf(id))!;
    // The handler the processor runs, driven by hand twice over the same fetched deadline.
    const handleTwice = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* EventStore;
      const executor = yield* CommandExecutor;
      const audit = yield* CommandAuditStore;
      const execute = (command: never, input: never) =>
        executor.runDecoded(command, input).pipe(Effect.provideService(EventStore, store), Effect.provideService(CommandAuditStore, audit), Effect.provideService(SqlClient.SqlClient, sql));
      const handler = makeDeadlineEventHandler(new Map([[ReleaseSeat.name, ReleaseSeat]]), execute as never, makeRecordFiring(sql, store), 30_000);
      const fetched = (yield* (yield* makeDeadlineFetcher()).fetchEvents(undefined as never, undefined as never, 100)).filter((e: StoredEvent) => e.position.toString() === scheduled.position);
      assert.strictEqual(fetched.length, 1);
      yield* handler.handle(DEADLINES_PROCESSOR_ID, fetched);
      yield* handler.handle(DEADLINES_PROCESSOR_ID, fetched);
    });
    await run(handleTwice);
    assert.deepStrictEqual((await eventsOf(id)).map((e) => e.type), ["DlpHeld", "DlpReleased"], "released once");
    assert.strictEqual((await firedFor(scheduled.position)).length, 1, "one DeadlineFired");
  });

  it("a command that takes longer than fireTimeoutMs is a fault: the batch stops there, nothing is recorded, and the deadline stays due", { timeout: 30_000 }, async () => {
    const id = seat();
    await exec(Hold, { seatId: id, forMs: 0 });
    const scheduled = (await deadlineOf(id))!;
    const fetchIt = Effect.map(Effect.flatMap(makeDeadlineFetcher(), (f) => f.fetchEvents(undefined as never, undefined as never, 100)), (es) =>
      es.filter((e: StoredEvent) => e.position.toString() === scheduled.position)
    );
    const handlerWith = (execute: unknown, fireTimeoutMs: number) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* EventStore;
        return makeDeadlineEventHandler(new Map([[ReleaseSeat.name, ReleaseSeat]]), execute as never, makeRecordFiring(sql, store), fireTimeoutMs);
      });
    // A command that never ends (a lock it waits on, a remote call that hangs).
    const stuck = Effect.gen(function* () {
      const handler = yield* handlerWith(() => Effect.never, 200);
      return yield* Effect.flip(handler.handle(DEADLINES_PROCESSOR_ID, yield* fetchIt));
    });
    const started = Date.now();
    const prefix = (await run(stuck)) as HandledPrefix;
    assert.ok(Date.now() - started < 5_000, "the handler gave up at the timeout");
    assert.strictEqual(prefix.handled, 0);
    assert.strictEqual((prefix.cause as { _tag: string })._tag, "DeadlineFireTimedOut");
    assert.deepStrictEqual(await firedFor(scheduled.position), [], "no firing recorded");
    assert.strictEqual((await rowFor(scheduled.position)).length, 1, "still due: the next tick retries it");
    assert.deepStrictEqual((await eventsOf(id)).map((e) => e.type), ["DlpHeld"]);

    // The retry, with a command that answers: fired once.
    await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const store = yield* EventStore;
        const audit = yield* CommandAuditStore;
        const sql = yield* SqlClient.SqlClient;
        const execute = (command: never, input: never) =>
          executor.runDecoded(command, input).pipe(Effect.provideService(EventStore, store), Effect.provideService(CommandAuditStore, audit), Effect.provideService(SqlClient.SqlClient, sql));
        const handler = yield* handlerWith(execute, 30_000);
        yield* handler.handle(DEADLINES_PROCESSOR_ID, yield* fetchIt);
      })
    );
    assert.deepStrictEqual((await eventsOf(id)).map((e) => e.type), ["DlpHeld", "DlpReleased"]);
    assert.strictEqual((await firedFor(scheduled.position)).length, 1);
  });

  it("the table can be rebuilt from the log: the deadlines scheduled and not fired", { timeout: 30_000 }, async () => {
    await exec(Hold, { seatId: seat(), forMs: 3_600_000 });
    const table = await query<{ p: string; due: string }>("SELECT deadline_position::text AS p, due_at::text AS due FROM crablet_deadlines ORDER BY 1");
    const rebuilt = await query<{ p: string; due: string }>(
      `SELECT s.position::text AS p, (s.data ->> 'dueAt')::timestamptz::text AS due FROM crablet_events s
        WHERE s.type = 'crablet.DeadlineScheduled'
          AND NOT EXISTS (SELECT 1 FROM crablet_events f WHERE f.type = 'crablet.DeadlineFired' AND f.causation_id = s.position) ORDER BY 1`
    );
    assert.ok(table.length >= 1);
    assert.deepStrictEqual(rebuilt, table);
  });

  it("a deadline that fell due while no processor ran fires once when one starts", { timeout: 30_000 }, async () => {
    const id = seat();
    await exec(Hold, { seatId: id, forMs: 0 });
    await new Promise((r) => setTimeout(r, 300));
    const scheduled = (await deadlineOf(id))!;
    await withProcessor(async () => {
      await until(() => firedFor(scheduled.position), (f) => f.length === 1, "the overdue deadline to fire");
      await new Promise((r) => setTimeout(r, 500));
    });
    assert.strictEqual((await firedFor(scheduled.position)).length, 1);
    assert.deepStrictEqual((await eventsOf(id)).map((e) => e.type), ["DlpHeld", "DlpReleased"]);
  });

  it("two instances: one holds the deadlines lock; when it stops, the other takes over and fires", { timeout: 60_000 }, async () => {
    const a = await run(makeDeadlinesProcessor({ commands: [ReleaseSeat], config, instanceId: "dl-a" }));
    const b = await run(makeDeadlinesProcessor({ commands: [ReleaseSeat], config, instanceId: "dl-b" }));
    await run(a.service.start);
    await run(b.service.start);
    try {
      const lockHolders = () =>
        query<{ pid: number }>("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND ((classid::bigint << 32) | objid::bigint) = $1::bigint", [DEADLINES_LOCK_KEY.toString()]);
      await until(lockHolders, (rows) => rows.length === 1, "one instance to lead");
      const aLeads = await run(a.isLeader);
      const leader = aLeads ? a : b;
      const follower = aLeads ? b : a;
      await run(leader.service.stop);
      await until(() => run(follower.isLeader), (v) => v, "the follower to take the lock");

      const id = seat();
      await exec(Hold, { seatId: id, forMs: 200 });
      await until(() => eventsOf(id), (es) => es.some((e) => e.type === "DlpReleased"), "the new leader to fire");
    } finally {
      await run(a.service.stop);
      await run(b.service.stop);
    }
  });

  it("the admin view counts the due deadlines and how late the oldest is", { timeout: 30_000 }, async () => {
    const handle = await run(makeDeadlinesProcessor({ commands: [ReleaseSeat], config, instanceId: "dl-admin" }));
    const service = await run(makeDeadlinesManagementService(handle));
    await exec(Hold, { seatId: seat(), forMs: 0 });
    await new Promise((r) => setTimeout(r, 1_100));
    const backlog = (await run(service.getBacklog(DEADLINES_PROCESSOR_ID) as Effect.Effect<NonNullable<unknown>, unknown, never>)) as { pendingEvents: number; oldestPendingSeconds: number | null };
    assert.ok(backlog.pendingEvents >= 1);
    assert.ok(backlog.oldestPendingSeconds !== null && backlog.oldestPendingSeconds >= 1);
    assert.strictEqual(await run(service.getLag(DEADLINES_PROCESSOR_ID) as Effect.Effect<unknown, unknown, never>), null);
  });

  // Last: it leaves the processor FAILED until reset.
  it("a deadline naming a command the processor was not given makes it FAILED after maxErrors; removing it and resetting brings it back", { timeout: 30_000 }, async () => {
    // Fire what the earlier tests left due, so only the bad deadline is in the way.
    await withProcessor(async () => {
      await until(() => query("SELECT 1 FROM crablet_deadlines WHERE due_at <= now()"), (r) => r.length === 0, "the due deadlines to be fired");
    });
    const Other = defineCommand({ name: "dlp_other", input: Schema.Struct({ seatId: Schema.String }), idempotentBy: (c) => Released.where({ seat_id: c.seatId }), decide: () => noop("X") });
    await run(CorrelationContext.withCorrelationId(crypto.randomUUID())(Effect.flatMap(EventStore, (store) => store.append([deadline(Other, { seatId: "x" }, { at: DateTime.nowUnsafe() })]))));
    const handle = await run(makeDeadlinesProcessor({ commands: [ReleaseSeat], config, instanceId: "dl-failing" }));
    const service = await run(makeDeadlinesManagementService(handle));
    await run(handle.service.start);
    try {
      const status = () => query<{ status: string; last_error: string | null }>("SELECT status, last_error FROM crablet_deadline_progress WHERE processor_name = $1", [DEADLINES_PROCESSOR_ID]);
      const failed = await until(status, (r) => r[0]?.status === "FAILED", "the processor to be FAILED");
      assert.match(failed[0]!.last_error ?? "", /dlp_other/);

      await query("DELETE FROM crablet_deadlines WHERE deadline_position IN (SELECT position FROM crablet_events WHERE type = 'crablet.DeadlineScheduled' AND data ->> 'command' = 'dlp_other')");
      await run(service.reset(DEADLINES_PROCESSOR_ID) as Effect.Effect<boolean, unknown, never>);
      const id = seat();
      await exec(Hold, { seatId: id, forMs: 0 });
      await until(() => eventsOf(id), (es) => es.some((e) => e.type === "DlpReleased"), "deadlines to fire again after the reset");
    } finally {
      await run(handle.service.stop);
    }
  });
});
