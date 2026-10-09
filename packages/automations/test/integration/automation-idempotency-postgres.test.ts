// Runs under Node (Testcontainers) - see NOTES.md. COMPARISON: the idempotency test utility runs on the in-memory event store, and an automation's author is told to trust it.
// Here the same scenarios run on it AND on real Postgres, through the real CommandExecutor, and the verdicts must be the same. Each scenario also has the verdict it is
// EXPECTED to give, so two backends agreeing on a wrong answer cannot pass.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { PgClient } from "@effect/sql-pg";
import * as Schema from "effect/Schema";
import { startTestDb, type TestDb } from "@crablet/test-support";
import { EventStore, EventStoreLive, type StoredEvent } from "@crablet/eventstore";
import { CommandAuditStoreLive, type CommandAuditStore } from "@crablet/eventstore/CommandAuditStore";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import * as EventSelectionNS from "@crablet/event-poller/EventSelection";
import { CommandExecutor, CommandExecutorLive } from "@crablet/commands";
import { defineCommand, emit, fail, type Command } from "@crablet/commands/Command";
import { DomainError } from "@crablet/commands/Errors";
import { defineEvent } from "@crablet/commands/Event";
import type { AutomationHandler } from "../../src/AutomationHandler.ts";
import { executeCommand } from "../../src/AutomationDecision.ts";
import {
  checkAutomationIdempotency,
  type IdempotencyBackend,
  type IdempotencyReport
} from "../../src/testing/AutomationIdempotency.ts";

type Services = CommandExecutor | EventStore | CommandAuditStore | SqlClient.SqlClient | PgClient.PgClient;
let db: TestDb;
let runtime: ManagedRuntime.ManagedRuntime<Services, never>;

before(async () => {
  db = await startTestDb();
  const pgLayer = PgClient.layer({ host: db.connInfo.host, port: db.connInfo.port, database: db.connInfo.database, username: db.connInfo.username, password: Redacted.make(db.connInfo.password) });
  runtime = ManagedRuntime.make(
    Layer.provideMerge(Layer.mergeAll(CommandExecutorLive, EventStoreLive, CommandAuditStoreLive), pgLayer) as unknown as Layer.Layer<Services, never>
  );
}, { timeout: 60_000 });

after(async () => {
  await runtime.dispose();
  await db.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);

// The same backend interface, over real Postgres and the real CommandExecutor (the production path, with its transaction, conflict retry and audit).
const postgresBackend: IdempotencyBackend = {
  seed: async (events: ReadonlyArray<AppendEvent>) => {
    if (events.length === 0) return [];
    return run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        const sql = yield* SqlClient.SqlClient;
        const stored: Array<StoredEvent> = [];
        // Each event is its own transaction, and the append says which: read it back by that. (Reading "the latest n positions" instead returned events of earlier
        // scenarios here; the cause was not found, and this does not depend on it.)
        for (const e of events) {
          const appended = yield* store.append([e]);
          const rows = yield* sql.unsafe<{
            type: string;
            tags: string[];
            data: unknown;
            transaction_id: string;
            position: string;
            occurred_at: Date;
            correlation_id: string | null;
            causation_id: string | null;
          }>(
            "SELECT type, tags, data, transaction_id::text AS transaction_id, position::text AS position, occurred_at, correlation_id, causation_id::text AS causation_id FROM crablet_events WHERE transaction_id = $1::xid8 ORDER BY position",
            [appended.transactionId]
          );
          for (const row of rows) {
            stored.push({
              type: row.type,
              tags: row.tags.map((raw: string) => {
                const i = raw.indexOf("=");
                return i < 0 ? { key: raw, value: "" } : { key: raw.slice(0, i), value: raw.slice(i + 1) };
              }),
              data: row.data,
              transactionId: row.transaction_id,
              position: BigInt(row.position),
              occurredAt: row.occurred_at,
              correlationId: row.correlation_id,
              causationId: row.causation_id === null ? null : BigInt(row.causation_id)
            });
          }
        }
        return stored;
      })
    );
  },
  execute: async (command: Command<any, any>, input: unknown, causation: bigint) => {
    const exit = await run(
      Effect.exit(
        Effect.flatMap(CommandExecutor, (executor) => CorrelationContext.withCausationId(causation)(executor.runDecoded(command, input)))
      )
    );
    if (Exit.isSuccess(exit)) return { _tag: "done", wasIdempotent: exit.value.wasIdempotent, reason: exit.value.reason } as const;
    const failure = exit.cause.reasons.find(Cause.isFailReason);
    return { _tag: "failed", detail: failure === undefined ? Cause.pretty(exit.cause) : JSON.stringify(failure.error) } as const;
  },
  count: () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql.unsafe<{ n: string }>("SELECT count(*)::text AS n FROM crablet_events");
        return Number(rows[0]!.n);
      })
    )
};

// ---- the scenarios. `uid` goes into every event type, so a scenario run twice (memory, then Postgres, which keeps its log) never meets its own earlier events.
class WalletNotOpen extends DomainError("WalletNotOpen", { fields: { walletId: Schema.String }, kind: "not_found" }) {}
const input = Schema.Struct({ walletId: Schema.String, depositId: Schema.String });
type In = { walletId: string; depositId: string };

interface Scenario {
  readonly name: string;
  readonly build: (uid: string) => {
    readonly automation: AutomationHandler<any, never, any>;
    readonly triggers: ReadonlyArray<AppendEvent>;
    readonly given?: ReadonlyArray<AppendEvent>;
  };
  // What the verdict must be on BOTH backends.
  readonly expect: { readonly ok: boolean; readonly effects: number; readonly kinds: ReadonlyArray<string> };
}

const world = (uid: string) => {
  const DepositMade = defineEvent(`DepositMade-${uid}`, {
    schema: Schema.Struct({ walletId: Schema.String, depositId: Schema.String }),
    tags: (d) => ({ wallet_id: d.walletId, deposit_id: d.depositId })
  });
  const Notified = defineEvent(`DepositNotified-${uid}`, {
    schema: Schema.Struct({ walletId: Schema.String, depositId: Schema.String }),
    tags: (d) => ({ wallet_id: d.walletId, deposit_id: d.depositId })
  });
  const Opened = defineEvent(`WalletOpened-${uid}`, { schema: Schema.Struct({ walletId: Schema.String }), tags: (d) => ({ wallet_id: d.walletId }) });
  const automationOf = (command: Command<any, any>): AutomationHandler<any, never, any> => ({
    automationName: `notify-deposit-${uid}`,
    command,
    decide: (event) => {
      const d = event.data as In;
      return Effect.succeed([executeCommand({ walletId: d.walletId, depositId: d.depositId })]);
    },
    ...EventSelectionNS.of({ eventTypes: new Set([`DepositMade-${uid}`]) }),
    pollingIntervalMs: undefined,
    batchSize: undefined,
    backoffEnabled: undefined,
    backoffThreshold: undefined,
    backoffMultiplier: undefined,
    backoffMaxSeconds: undefined
  });
  const notify = (idempotentBy?: (c: In) => ReturnType<typeof Notified.where>) =>
    defineCommand({ name: "NotifyDeposit", input, ...(idempotentBy ? { idempotentBy } : {}), decide: (_, c) => emit(Notified(c)) });
  const sameWallet = [DepositMade({ walletId: `w1-${uid}`, depositId: `d1-${uid}` }), DepositMade({ walletId: `w1-${uid}`, depositId: `d2-${uid}` })];
  const otherWallets = [DepositMade({ walletId: `w1-${uid}`, depositId: `d1-${uid}` }), DepositMade({ walletId: `w2-${uid}`, depositId: `d2-${uid}` })];
  return { DepositMade, Notified, Opened, automationOf, notify, sameWallet, otherWallets };
};

const scenarios: ReadonlyArray<Scenario> = [
  {
    name: "a key on the deposit: passes",
    build: (uid) => {
      const w = world(uid);
      return { automation: w.automationOf(w.notify((c) => w.Notified.where({ deposit_id: c.depositId }))), triggers: w.sameWallet };
    },
    expect: { ok: true, effects: 2, kinds: [] }
  },
  {
    name: "no idempotentBy: the repeat appends again",
    build: (uid) => {
      const w = world(uid);
      return { automation: w.automationOf(w.notify()), triggers: w.sameWallet };
    },
    expect: { ok: false, effects: 2, kinds: ["NOT IDEMPOTENT"] }
  },
  {
    name: "a key on the wallet, two deposits to ONE wallet: too broad",
    build: (uid) => {
      const w = world(uid);
      return { automation: w.automationOf(w.notify((c) => w.Notified.where({ wallet_id: c.walletId }))), triggers: w.sameWallet };
    },
    expect: { ok: false, effects: 1, kinds: ["TOO BROAD"] }
  },
  {
    name: "a key on the wallet, two deposits to DIFFERENT wallets: not seen (the check is only as good as its triggers)",
    build: (uid) => {
      const w = world(uid);
      return { automation: w.automationOf(w.notify((c) => w.Notified.where({ wallet_id: c.walletId }))), triggers: w.otherWallets };
    },
    expect: { ok: true, effects: 2, kinds: [] }
  },
  {
    name: "a misspelled tag in the key: never matches, the repeat appends again",
    build: (uid) => {
      const w = world(uid);
      return { automation: w.automationOf(w.notify((c) => w.Notified.where({ depositid: c.depositId } as never))), triggers: w.sameWallet };
    },
    expect: { ok: false, effects: 2, kinds: ["NOT IDEMPOTENT"] }
  },
  {
    name: "a command that needs a wallet nobody opened: FAILED for each trigger",
    build: (uid) => {
      const w = world(uid);
      const needsWallet = defineCommand({
        name: "NotifyOpenWallet",
        input,
        errors: [WalletNotOpen],
        idempotentBy: (c) => w.Notified.where({ deposit_id: c.depositId }),
        prepare: (c, es) => es.exists(w.Opened.where({ wallet_id: c.walletId })),
        decide: (_, c, isOpen) => (isOpen ? emit(w.Notified(c)) : fail(new WalletNotOpen({ walletId: c.walletId })))
      });
      return { automation: w.automationOf(needsWallet), triggers: w.sameWallet };
    },
    expect: { ok: false, effects: 0, kinds: ["FAILED", "FAILED"] }
  },
  {
    name: "the same command with the wallet given: passes",
    build: (uid) => {
      const w = world(uid);
      const needsWallet = defineCommand({
        name: "NotifyOpenWallet",
        input,
        errors: [WalletNotOpen],
        idempotentBy: (c) => w.Notified.where({ deposit_id: c.depositId }),
        prepare: (c, es) => es.exists(w.Opened.where({ wallet_id: c.walletId })),
        decide: (_, c, isOpen) => (isOpen ? emit(w.Notified(c)) : fail(new WalletNotOpen({ walletId: c.walletId })))
      });
      return { automation: w.automationOf(needsWallet), triggers: w.sameWallet, given: [w.Opened({ walletId: `w1-${uid}` })] };
    },
    expect: { ok: true, effects: 2, kinds: [] }
  }
];

// What the two backends must agree on: not the wording (positions differ), the verdict.
const verdict = (report: IdempotencyReport) => ({
  ok: report.ok,
  effects: report.effects,
  kinds: report.problems.map((p) => p.slice(0, p.indexOf(":"))).sort()
});

describe("the idempotency utility gives the same verdict on the in-memory store and on real Postgres", () => {
  for (const scenario of scenarios) {
    it(scenario.name, { timeout: 30_000 }, async () => {
      const mem = scenario.build(`mem${crypto.randomUUID().slice(0, 8)}`);
      const pg = scenario.build(`pg${crypto.randomUUID().slice(0, 8)}`);

      const inMemory = verdict(await checkAutomationIdempotency(mem.automation, mem.triggers, mem.given === undefined ? {} : { given: mem.given }));
      const pgReport = await checkAutomationIdempotency(pg.automation, pg.triggers, { ...(pg.given === undefined ? {} : { given: pg.given }), backend: postgresBackend });
      const onPostgres = verdict(pgReport);

      assert.deepStrictEqual(inMemory, scenario.expect, "in memory, the verdict the scenario is meant to give");
      assert.deepStrictEqual(onPostgres, scenario.expect, "on Postgres, the same verdict");
    });
  }
});
