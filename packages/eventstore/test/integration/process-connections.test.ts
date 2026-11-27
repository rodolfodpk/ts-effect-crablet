// Runs under Node (Testcontainers). The connections a process holds outside the pool's churn (ADR-0055): its lock session and its LISTEN connection
// live in the `ProcessConnections` service and close with its layer, even when a leader or a listen was left open.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Context, Effect, Exit, Layer, ManagedRuntime, Redacted, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { ProcessConnections, ProcessConnectionsLive } from "../../src/ProcessConnections.ts";

type Rt = ManagedRuntime.ManagedRuntime<SqlClient.SqlClient | PgClient.PgClient, never>;
let db: TestDb;
let proc: Rt;
let probe: Rt;
const runtime = (name: string): Rt =>
  ManagedRuntime.make(PgClient.layer({
    host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), applicationName: name
  }).pipe(Layer.orDie));

before(async () => {
  db = await startTestDb();
  proc = runtime("process-connections");
  probe = runtime("probe");
}, { timeout: 60_000 });
after(async () => {
  await proc.dispose();
  await probe.dispose();
  await db.stop();
});

const KEY = 9200000000000000001n;
// With a lease (`serverIdleTimeout`), so closing also resets it on the connection it gives back.
const fast = { heartbeat: "100 millis", verifyTimeout: "500 millis", failuresBeforeLost: 2, serverIdleTimeout: "5 seconds" } as const;
const lockHeld = () =>
  probe.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.unsafe<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND ((classid::bigint << 32) | objid::bigint) = $1::bigint",
      [KEY.toString()]
    )
  )).then((r) => r[0]!.n > 0);
const listening = () =>
  probe.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.unsafe<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'process-connections' AND query LIKE 'LISTEN%'")
  )).then((r) => r[0]!.n);
// What a closed connection held is seen gone a moment after the close: its backend leaves pg_locks and pg_stat_activity when it exits, which the
// server does after the client's socket closes, not before `close` returns.
const eventually = async <A>(read: () => Promise<A>, expected: A, message: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  let seen = await read();
  while (seen !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    seen = await read();
  }
  assert.strictEqual(seen, expected, message);
};

describe("ProcessConnections (ADR-0055)", () => {
  it("closing the layer gives back a lock session and a LISTEN connection that were left open", { timeout: 30_000 }, async () => {
    const layerScope = await proc.runPromise(Scope.make());
    const callerScope = await proc.runPromise(Scope.make());
    await proc.runPromise(
      Effect.gen(function* () {
        const built = yield* Scope.provide(Layer.build(ProcessConnectionsLive), layerScope);
        const connections = Context.get(built, ProcessConnections);
        const sql = yield* SqlClient.SqlClient;
        const pg = yield* PgClient.PgClient;
        // a leader that is never released, and a listen whose caller's scope stays open
        const leader = yield* connections.leaders.tryLead(sql, KEY, fast);
        assert.ok(leader !== null, "it leads");
        yield* Scope.provide(connections.listens.listen(pg, "crablet_process_connections_test"), callerScope);
      })
    );
    assert.strictEqual(await lockHeld(), true, "the lock is held while the layer lives");
    assert.strictEqual(await listening(), 1, "one LISTEN connection while the layer lives");

    await proc.runPromise(Scope.close(layerScope, Exit.void));
    await eventually(lockHeld, false, "the layer closed the lock session");
    await eventually(listening, 0, "the layer closed the LISTEN connection");
    await proc.runPromise(Scope.close(callerScope, Exit.void));
  });

  it("two layers are two processes: each has its own registry, so a second layer's attempt is refused by Postgres, not by the first's session", { timeout: 30_000 }, async () => {
    const first = await proc.runPromise(Scope.make());
    const second = await proc.runPromise(Scope.make());
    const [a, b] = await proc.runPromise(
      Effect.gen(function* () {
        const one = Context.get(yield* Scope.provide(Layer.build(ProcessConnectionsLive), first), ProcessConnections);
        const two = Context.get(yield* Scope.provide(Layer.build(ProcessConnectionsLive), second), ProcessConnections);
        const sql = yield* SqlClient.SqlClient;
        return [yield* one.leaders.tryLead(sql, KEY, fast), yield* two.leaders.tryLead(sql, KEY, fast)] as const;
      })
    );
    assert.ok(a !== null, "the first leads");
    assert.strictEqual(b, null, "the second, on its own session, does not get the lock");
    await proc.runPromise(Scope.close(second, Exit.void));
    assert.strictEqual(await lockHeld(), true, "closing the second leaves the first's lock alone");
    await proc.runPromise(Scope.close(first, Exit.void));
    await eventually(lockHeld, false, "closing the first gives the lock back");
  });
});
