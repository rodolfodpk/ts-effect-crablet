// Runs under Node (Testcontainers). The same trigger cannot append the same request twice (ADR-0035): an append made under a cause (an automation's trigger)
// stores an emit key - the request's fingerprint and the event's place - that is unique per cause. It stops a redelivered trigger even when the command's
// idempotency query never matches, and it is keyed by content, so a redelivery whose decide returns more decisions still appends what is new.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Exit, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import * as Schema from "effect/Schema";
import { startTestDb, type TestDb } from "@crablet/test-support";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import * as Crablet from "../../src/Crablet.ts";
import { CommandExecutor } from "../../src/CommandExecutor.ts";
import { defineCommand, emit } from "../../src/Command.ts";
import { defineEvent } from "../../src/Event.ts";

let db: TestDb;
before(async () => {
  db = await startTestDb();
}, { timeout: 60_000 });
after(async () => {
  await db.stop();
});

const AppLive = () =>
  Crablet.layer({
    host: db.connInfo.host,
    port: db.connInfo.port,
    database: db.connInfo.database,
    username: db.connInfo.username,
    password: Redacted.make(db.connInfo.password)
  });
const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.provide(e, AppLive()) as Effect.Effect<A, E, never>);

const Notified = defineEvent("TB_Notified", { schema: Schema.Struct({ walletId: Schema.String, kind: Schema.String }), tags: (d) => ({ wallet_id: d.walletId }) });
const notifyInput = Schema.Struct({ walletId: Schema.String, kind: Schema.String });
// Its key never matches what it appends (a misspelled tag): the case the backstop is for.
const Notify = defineCommand({
  name: "tb_notify",
  input: notifyInput,
  idempotentBy: (c) => Notified.where({ walletid: c.walletId } as never),
  decide: (_, c) => emit(Notified(c))
});

// A trigger's position: any number no real event uses in this test database is enough.
const trigger = () => BigInt(1_000_000 + Math.floor(Math.random() * 1_000_000_000));
const underTrigger = (position: bigint, input: typeof notifyInput.Type) =>
  Effect.flatMap(CommandExecutor, (x) => CorrelationContext.withCausationId(position)(x.runDecoded(Notify, input)));

const notified = (walletId: string) =>
  run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.unsafe<{ kind: string; emit_key: string | null }>(
        "SELECT data->>'kind' AS kind, emit_key FROM crablet_events WHERE type = 'TB_Notified' AND tags @> ARRAY[$1]::text[] ORDER BY position",
        [`wallet_id=${walletId}`]
      )
    )
  );

describe("the same trigger cannot append the same request twice (ADR-0035, real Postgres)", () => {
  it("a redelivered trigger whose key never matches appends nothing the second time, and says the backstop caught it", { timeout: 30_000 }, async () => {
    const walletId = crypto.randomUUID();
    const t = trigger();
    const first = await run(underTrigger(t, { walletId, kind: "welcome" }));
    const again = await run(underTrigger(t, { walletId, kind: "welcome" }));
    assert.equal(first.wasIdempotent, false);
    assert.equal(again.wasIdempotent, true);
    assert.equal(again.reason, "ALREADY_DONE_FOR_TRIGGER");
    assert.deepEqual(again.marker, first.marker, "with the earlier write's marker");
    const rows = await notified(walletId);
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.emit_key ?? "", /^[0-9a-f]{64}\/1$/);
  });

  it("keyed by content, not by the decision's place: a redelivery that decides [B, A] after [A] appends B and not A again", { timeout: 30_000 }, async () => {
    const walletId = crypto.randomUUID();
    const t = trigger();
    await run(underTrigger(t, { walletId, kind: "A" }));
    const b = await run(underTrigger(t, { walletId, kind: "B" }));
    const a = await run(underTrigger(t, { walletId, kind: "A" }));
    assert.equal(b.wasIdempotent, false, "B is new: appended");
    assert.equal(a.wasIdempotent, true, "A was done: not appended again");
    assert.deepEqual((await notified(walletId)).map((r) => r.kind), ["A", "B"]);
  });

  it("two deliveries of one trigger racing (a zombie and its successor): one appends, the other is already done", { timeout: 30_000 }, async () => {
    const walletId = crypto.randomUUID();
    const t = trigger();
    const results = await run(
      Effect.gen(function* () {
        const executor = yield* CommandExecutor;
        const bothDecided = yield* Deferred.make<void>();
        let arrived = 0;
        const Racing = defineCommand({
          name: "tb_notify_racing",
          input: notifyInput,
          idempotentBy: (c) => Notified.where({ walletid: c.walletId } as never),
          resolve: () => Effect.suspend(() => (++arrived === 2 ? Deferred.succeed(bothDecided, undefined) : Effect.void)).pipe(Effect.andThen(Deferred.await(bothDecided))),
          decide: (_, c) => emit(Notified(c))
        });
        const one = CorrelationContext.withCausationId(t)(executor.runDecoded(Racing, { walletId, kind: "welcome" }));
        return yield* Effect.all([Effect.exit(one), Effect.exit(one)], { concurrency: 2 });
      })
    );
    assert.ok(results.every(Exit.isSuccess), "neither fails");
    const outcomes = results.map((r) => (Exit.isSuccess(r) ? r.value.wasIdempotent : null)).sort();
    assert.deepEqual(outcomes, [false, true]);
    assert.equal((await notified(walletId)).length, 1);
  });

  it("a request from outside (no cause) has no emit key and is not affected", { timeout: 30_000 }, async () => {
    const walletId = crypto.randomUUID();
    await run(Effect.flatMap(CommandExecutor, (x) => x.runDecoded(Notify, { walletId, kind: "welcome" })));
    await run(Effect.flatMap(CommandExecutor, (x) => x.runDecoded(Notify, { walletId, kind: "welcome" })));
    const rows = await notified(walletId);
    assert.equal(rows.length, 2, "with a key that never matches and no cause, nothing recognises the repeat: that is what idempotentBy is for");
    assert.ok(rows.every((r) => r.emit_key === null));
  });
});
