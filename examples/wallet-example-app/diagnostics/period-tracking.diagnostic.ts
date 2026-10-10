// DIAGNOSTIC EXPERIMENT (docs/plans/period-follow-ups.md, B1), not a test: it measures, it does not assert. Needs Docker. Run with:
//   node --test examples/wallet-example-app/diagnostics/period-tracking.diagnostic.ts     and read the `DIAG` lines.
// What a model with a period pays to turn it. On the common path (the period is open) a load is one read, like any model. On the turn path it also reads the entity's tracking: EVERY opening and closing it
// ever had, which grows with the number of periods. This builds an entity with N daily periods (an opening, a closing and one event each), then times, over 30 repetitions: the load on the common path, the
// load on the turn path (the day after the last), and a whole command that turns. One run, one machine, Postgres in a container.
import { after, before, describe, it } from "node:test";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import * as Schema from "effect/Schema";
import { PgClient } from "@effect/sql-pg";
import { EventStore, makeEventStoreLayer } from "@crablet/eventstore";
import { CommandAuditStoreLive } from "@crablet/eventstore/CommandAuditStore";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { defineCommand, emit } from "@crablet/commands/Command";
import { defineEvent } from "@crablet/commands/Event";
import { defineModel } from "@crablet/commands/Model";
import { Period } from "@crablet/commands/Period";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { applyAppMigrations } from "../test/support/applyAppMigrations.ts";
import { atClock } from "../test/support/clocked-commands.ts";

const Born = defineEvent("DX_Born", { schema: Schema.Struct({ id: Schema.String }), tags: (d) => ({ acct: d.id }) });
const Opened = defineEvent("DX_Opened", { schema: Schema.Struct({ id: Schema.String, year: Schema.Number, month: Schema.Number, day: Schema.Number, opening: Schema.Number }), tags: (d) => ({ acct: d.id, year: d.year, month: d.month, day: d.day }) });
const Closed = defineEvent("DX_Closed", { schema: Schema.Struct({ id: Schema.String, year: Schema.Number, month: Schema.Number, day: Schema.Number, closing: Schema.Number }), tags: (d) => ({ acct: d.id, year: d.year, month: d.month, day: d.day }) });
const Credited = defineEvent("DX_Credited", { schema: Schema.Struct({ id: Schema.String, amount: Schema.Number }), tags: (d) => ({ acct: d.id }) });
const Model = defineModel({ by: "acct", initial: () => ({ exists: false, balance: 0 }) })
  .lifecycle(Born, () => ({ exists: true, balance: 0 }))
  .on(Opened, (a, d) => ({ ...a, balance: d.opening }))
  .on(Credited, (a, d) => ({ ...a, balance: a.balance + d.amount }))
  .period(Period.day, {
    opened: Opened,
    closed: Closed,
    open: (carry, p) => ({ id: p.id, ...p.fields, opening: carry.balance }),
    close: (state, p) => ({ id: p.id, ...p.fields, closing: state.balance })
  });
const Credit = defineCommand({ name: "dx_credit", input: Schema.Struct({ id: Schema.String }), model: (c) => Model.of({ id: c.id }), decide: (a, c) => emit(Credited({ id: c.id, amount: 1 }, a.period.tags)) });

let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<CommandExecutor | EventStore, never>;
before(async () => {
  db = await startTestDb();
  await applyAppMigrations(db.connInfo);
  runtime = ManagedRuntime.make(
    Layer.provideMerge(
      Layer.mergeAll(CommandExecutorLive, makeEventStoreLayer({ wakeupMode: "off" }), CommandAuditStoreLive),
      PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password), maxConnections: 10 })
    ) as never
  );
}, { timeout: 60_000 });
after(async () => { await runtime.dispose(); await db.stop(); });

const day0 = Date.UTC(2000, 0, 1, 12);
const dayAt = (i: number) => new Date(day0 + i * 86_400_000);
const f = (d: Date) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const time = async (n: number, fn: () => Promise<unknown>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); out.push(performance.now() - t); }
  return out;
};

describe("what turning a period costs as an entity gets more of them", () => {
  for (const periods of [100, 1_000, 10_000]) {
    it(`${periods} daily periods`, { timeout: 300_000 }, async () => {
      const id = `d-${periods}-${crypto.randomUUID().slice(0, 6)}`;
      const events: any[] = [Born({ id })];
      for (let i = 0; i < periods; i++) {
        if (i > 0) events.push(Closed({ id, ...f(dayAt(i - 1)), closing: i }));
        events.push(Opened({ id, ...f(dayAt(i)), opening: i }), Credited({ id, amount: 1 }, [] as never));
      }
      for (let i = 0; i < events.length; i += 50) await runtime.runPromise(Effect.flatMap(EventStore, (es) => es.append(events.slice(i, i + 50))) as never);
      const last = dayAt(periods - 1);
      const next = dayAt(periods);
      const load = (when: Date) => () => runtime.runPromise(atClock(() => when, Effect.flatMap(EventStore, (es) => Model.of({ id }).load(es))) as never);
      await time(3, load(last)); // warm up
      const common = await time(30, load(last));
      const turn = await time(30, load(next));
      const whole = await time(10, async () => runtime.runPromise(atClock(() => dayAt(periods + 1 + Math.floor(Math.random() * 1e6)), Effect.flatMap(CommandExecutor, (ex) => (ex as any).run(Credit, { id }))) as never).catch(() => undefined));
      console.log(`DIAG periods=${periods} common load p50=${pct(common, 50).toFixed(2)} ms p95=${pct(common, 95).toFixed(2)} | turn load p50=${pct(turn, 50).toFixed(2)} ms p95=${pct(turn, 95).toFixed(2)} | a turning command (first call is the turn) p50=${pct(whole, 50).toFixed(2)} ms`);
    });
  }
});
