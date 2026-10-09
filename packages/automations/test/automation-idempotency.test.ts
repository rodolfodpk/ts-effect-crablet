import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as EventSelectionNS from "@crablet/event-poller/EventSelection";
import { defineCommand, emit, fail, type Command } from "@crablet/commands/Command";
import { DomainError } from "@crablet/commands/Errors";
import { defineEvent } from "@crablet/commands/Event";
import type { StoredEvent } from "@crablet/eventstore";
import { assertAutomationIdempotent, checkAutomationIdempotency } from "../src/testing/AutomationIdempotency.ts";
import { automationHandlerOf, type AutomationHandler } from "../src/AutomationHandler.ts";
import { executeCommand } from "../src/AutomationDecision.ts";

// The scenario: a deposit is made; the automation notifies about it. A deposit has its own id; a wallet has many deposits.
const DepositMade = defineEvent("DepositMade", {
  schema: Schema.Struct({ walletId: Schema.String, depositId: Schema.String }),
  tags: (d) => ({ wallet_id: d.walletId, deposit_id: d.depositId })
});
const Notified = defineEvent("DepositNotified", {
  schema: Schema.Struct({ walletId: Schema.String, depositId: Schema.String }),
  tags: (d) => ({ wallet_id: d.walletId, deposit_id: d.depositId })
});
const input = Schema.Struct({ walletId: Schema.String, depositId: Schema.String });
const dataOf = (e: StoredEvent) => e.data as { walletId: string; depositId: string };

const notifyWith = (idempotentBy?: (c: { walletId: string; depositId: string }) => ReturnType<typeof Notified.where>) =>
  defineCommand({ name: "NotifyDeposit", input, ...(idempotentBy ? { idempotentBy } : {}), decide: (_, c) => emit(Notified(c)) });

const automationOf = (command: Command<any, any>): AutomationHandler<any, never, any> => ({
  automationName: "notify-deposit",
  command,
  decide: (event) => Effect.succeed([executeCommand({ walletId: dataOf(event).walletId, depositId: dataOf(event).depositId })]),
  ...EventSelectionNS.of({ eventTypes: new Set(["DepositMade"]) }),
  pollingIntervalMs: undefined,
  batchSize: undefined,
  backoffEnabled: undefined,
  backoffThreshold: undefined,
  backoffMultiplier: undefined,
  backoffMaxSeconds: undefined
});

// two deposits to the SAME wallet: the case that exposes a key on the wallet
const triggers = [DepositMade({ walletId: "w1", depositId: "d1" }), DepositMade({ walletId: "w1", depositId: "d2" })];

describe("checkAutomationIdempotency", () => {
  test("a command keyed on the deposit passes, and reports one effect per trigger", async () => {
    const good = notifyWith((c) => Notified.where({ deposit_id: c.depositId }));
    const report = await checkAutomationIdempotency(automationOf(good), triggers);
    expect(report).toEqual({ ok: true, problems: [], effects: 2 });
  });

  test("a command with no idempotentBy: the repeat appends again", async () => {
    const report = await checkAutomationIdempotency(automationOf(notifyWith()), triggers);
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatch(/NOT IDEMPOTENT.*appended 2 more event/);
  });

  test("a key too broad (the wallet): the second deposit's notification would be dropped", async () => {
    const broad = notifyWith((c) => Notified.where({ wallet_id: c.walletId }));
    const report = await checkAutomationIdempotency(automationOf(broad), triggers);
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => /TOO BROAD.*FIRST pass/.test(p))).toBe(true);
    expect(report.effects).toBe(1);
  });

  test("a key too broad is NOT seen with triggers that never share it (what the check is only as good as)", async () => {
    const broad = notifyWith((c) => Notified.where({ wallet_id: c.walletId }));
    const distinctWallets = [DepositMade({ walletId: "w1", depositId: "d1" }), DepositMade({ walletId: "w2", depositId: "d2" })];
    expect((await checkAutomationIdempotency(automationOf(broad), distinctWallets)).ok).toBe(true);
  });

  test("a key that never matches (a misspelled tag): the repeat appends again", async () => {
    const typo = notifyWith((c) => Notified.where({ depositid: c.depositId } as never));
    const report = await checkAutomationIdempotency(automationOf(typo), triggers);
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => /NOT IDEMPOTENT/.test(p))).toBe(true);
  });

  test("a command that needs state the test did not give is reported as FAILED, and { given } fixes it", async () => {
    class WalletNotOpen extends DomainError("WalletNotOpen", { fields: { walletId: Schema.String }, kind: "not_found" }) {}
    const Opened = defineEvent("WalletOpened", { schema: Schema.Struct({ walletId: Schema.String }), tags: (d) => ({ wallet_id: d.walletId }) });
    const needsWallet = defineCommand({
      name: "NotifyOpenWallet",
      input,
      errors: [WalletNotOpen],
      idempotentBy: (c) => Notified.where({ deposit_id: c.depositId }),
      prepare: (c, es) => es.exists(Opened.where({ wallet_id: c.walletId })),
      decide: (_, c, isOpen) => (isOpen ? emit(Notified(c)) : fail(new WalletNotOpen({ walletId: c.walletId })))
    });

    const without = await checkAutomationIdempotency(automationOf(needsWallet), triggers);
    expect(without.ok).toBe(false);
    expect(without.problems.every((p) => /FAILED.*WalletNotOpen|FAILED/.test(p))).toBe(true);
    expect(without.problems[0]).toMatch(/Give it the events it needs with \{ given \}/);

    const withWallet = await checkAutomationIdempotency(automationOf(needsWallet), triggers, { given: [Opened({ walletId: "w1" })] });
    expect(withWallet).toEqual({ ok: true, problems: [], effects: 2 });
  });
});

describe("assertAutomationIdempotent", () => {
  test("throws, listing the problems", async () => {
    await expect(assertAutomationIdempotent(automationOf(notifyWith()), triggers)).rejects.toThrow(/automation "notify-deposit" is not idempotent/);
  });

  test("returns the report when all is well, for an automation built with automationHandlerOf", async () => {
    const good = notifyWith((c) => Notified.where({ deposit_id: c.depositId }));
    const automation = automationHandlerOf("notify-deposit", good, (e) => Effect.succeed([executeCommand({ walletId: dataOf(e).walletId, depositId: dataOf(e).depositId })]), {
      eventTypes: new Set(["DepositMade"])
    });
    expect((await assertAutomationIdempotent(automation, triggers)).effects).toBe(2);
  });
});
