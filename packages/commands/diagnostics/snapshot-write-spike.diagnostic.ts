// SPIKE for ADR-0018 open point 3: how may a snapshot be written when the load happens INSIDE the command's transaction? Not a test, it measures.
// Run:  node --test packages/commands/diagnostics/snapshot-write-spike.diagnostic.ts   and read the `DIAG` lines. Real Postgres (Testcontainers, needs Docker).
//   A. Can code inside `sql.withTransaction` run a statement OUTSIDE it (own connection, survives a rollback)?   B. What does that do to a small pool?
//   C. Does "collect inside, write after the commit" avoid it, also when the transaction fails?
import { after, before, describe, it } from "node:test";
import { Context, Effect, Layer, Ref, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import { startTestDb, type TestDb } from "@crablet/test-support";

let db: TestDb;
const layerOf = (maxConnections: number) =>
  PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), maxConnections }) as unknown as Layer.Layer<SqlClient.SqlClient, never>;
before(async () => { db = await startTestDb(); }, { timeout: 60_000 });
after(async () => { await db.stop(); });
const run = <A, E>(pool: number, e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.runPromise(Effect.provide(e, layerOf(pool)) as Effect.Effect<A, E, never>);

const setup = Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("CREATE TABLE IF NOT EXISTS spike (k TEXT PRIMARY KEY, v TEXT NOT NULL)"));
const pid = (sql: SqlClient.SqlClient) => Effect.map(sql.unsafe<{ p: number }>("SELECT pg_backend_pid() AS p"), (r) => r[0]!.p);
const write = (sql: SqlClient.SqlClient, k: string) => sql.unsafe("INSERT INTO spike (k, v) VALUES ($1, 'x') ON CONFLICT (k) DO NOTHING", [k]);
const exists = (sql: SqlClient.SqlClient, k: string) => Effect.map(sql.unsafe<{ n: string }>("SELECT count(*) AS n FROM spike WHERE k = $1", [k]), (r) => Number(r[0]!.n) > 0);
// the same client, with the ambient transaction removed from the context: statements go to the pool, not to the transaction's connection
const outside = <A, E>(sql: SqlClient.SqlClient, e: Effect.Effect<A, E, never>) => Effect.updateContext(e, Context.omit(sql.transactionService) as never) as Effect.Effect<A, E, never>;

class Pending extends Context.Service<Pending, Ref.Ref<ReadonlyArray<string>>>()("Pending") {}

describe("DIAG snapshot write spike", () => {
  it("A. a statement can leave the ambient transaction: another backend, and it survives the rollback", { timeout: 60_000 }, async () => {
    const r = await run(4, Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* setup;
      const out = yield* Effect.exit(sql.withTransaction(Effect.gen(function* () {
        const inTx = yield* pid(sql);
        const outPid = yield* outside(sql, pid(sql));
        yield* outside(sql, write(sql, "written-outside"));
        yield* write(sql, "written-inside");
        return yield* Effect.fail({ inTx, outPid });
      })));
      return { out, outside: yield* exists(sql, "written-outside"), inside: yield* exists(sql, "written-inside") };
    }));
    const detail = (r.out as any).cause?.reasons?.[0]?.error;
    console.log(`DIAG A inside the transaction backend ${detail?.inTx}; a statement run "outside" used backend ${detail?.outPid}; after the transaction rolled back: outside write present=${r.outside}, inside write present=${r.inside}`);
  });

  it("B. writing outside from inside a transaction, with the pool as small as the load: does it deadlock?", { timeout: 60_000 }, async () => {
    for (const [pool, concurrent] of [[2, 2], [4, 4], [4, 12]] as const) {
      const r = await run(pool, Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* setup;
        const t0 = Date.now();
        const exits = yield* Effect.all(
          Array.from({ length: concurrent }, (_, i) =>
            Effect.exit(Effect.timeout(sql.withTransaction(Effect.andThen(Effect.sleep("100 millis"), outside(sql, write(sql, `b-${pool}-${concurrent}-${i}`)))), "4 seconds"))),
          { concurrency: concurrent }
        );
        return { ok: exits.filter((e) => e._tag === "Success").length, ms: Date.now() - t0 };
      }));
      console.log(`DIAG B pool ${pool}, ${concurrent} concurrent commands each writing "outside" from inside their transaction: ${r.ok}/${concurrent} finished within 4 s (${r.ms} ms)`);
    }
  });

  it("C. collect inside, write after the commit: same loads, same pools", { timeout: 60_000 }, async () => {
    for (const [pool, concurrent, failing] of [[2, 2, false], [4, 12, false], [4, 12, true]] as const) {
      const r = await run(pool, Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* setup;
        const t0 = Date.now();
        const exits = yield* Effect.all(
          Array.from({ length: concurrent }, (_, i) =>
            Effect.gen(function* () {
              const pending = yield* Ref.make<ReadonlyArray<string>>([]);
              const key = `c-${pool}-${concurrent}-${failing}-${i}`;
              // the "command": loads (collects what it would write) and then commits or fails
              const command = sql.withTransaction(
                Effect.gen(function* () {
                  const p = yield* Pending;
                  yield* Ref.update(p, (xs) => [...xs, key]); // what `load` does when it folded enough events
                  yield* Effect.sleep("100 millis");
                  if (failing) return yield* Effect.fail("conflict");
                })
              ).pipe(Effect.provideService(Pending, pending));
              // after the transaction ENDED, committed or not, on the connection it has already given back
              return yield* Effect.exit(Effect.ensuring(command, Effect.flatMap(Ref.get(pending), (keys) => Effect.forEach(keys, (k) => write(sql, k).pipe(Effect.ignore)))));
            })
          ),
          { concurrency: concurrent }
        );
        const written = yield* Effect.forEach(Array.from({ length: concurrent }, (_, i) => `c-${pool}-${concurrent}-${failing}-${i}`), (k) => exists(sql, k));
        return { ok: exits.filter((e) => e._tag === "Success").length, written: written.filter(Boolean).length, ms: Date.now() - t0 };
      }));
      console.log(`DIAG C pool ${pool}, ${concurrent} concurrent commands, ${failing ? "every transaction fails" : "all commit"}: ${r.ok} committed, ${r.written}/${concurrent} snapshots written after the transaction ended (${r.ms} ms)`);
    }
  });
});
