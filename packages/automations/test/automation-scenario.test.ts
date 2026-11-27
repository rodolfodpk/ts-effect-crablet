import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import * as Schema from "effect/Schema";
import { defineCommand, emit, fail } from "@crablet/commands/Command";
import { DomainError } from "@crablet/commands/Errors";
import { defineEvent } from "@crablet/eventstore/Event";
import { defineModel } from "@crablet/commands/Model";
import { defineAutomation } from "../src/AutomationHandler.ts";
import { automationScenario } from "../src/testing/AutomationScenario.ts";

// A wallet is opened; the automation welcomes its owner, once per wallet. A wallet opened with no owner is not welcomed (the handler asks for nothing),
// and a welcome to a closed wallet is refused by the command.
const WalletOpened = defineEvent("WalletOpened", {
  schema: Schema.Struct({ walletId: Schema.String, owner: Schema.String }),
  tags: (d) => ({ wallet_id: d.walletId })
});
const WalletClosed = defineEvent("WalletClosed", { schema: Schema.Struct({ walletId: Schema.String }), tags: (d) => ({ wallet_id: d.walletId }) });
const Welcomed = defineEvent("Welcomed", {
  schema: Schema.Struct({ walletId: Schema.String, owner: Schema.String, at: Schema.DateTimeUtcFromMillis }),
  tags: (d) => ({ wallet_id: d.walletId })
});
class WalletIsClosed extends DomainError("WalletIsClosed", { fields: { walletId: Schema.String }, kind: "conflict" }) {}

const WalletStatus = defineModel({ by: "wallet_id", initial: () => ({ closed: false }) }).on(WalletClosed, () => ({ closed: true }));
const Welcome = defineCommand({
  name: "welcome",
  input: Schema.Struct({ walletId: Schema.String, owner: Schema.String }),
  errors: [WalletIsClosed],
  model: (c) => WalletStatus.of({ id: c.walletId }),
  idempotentBy: (c) => Welcomed.where({ wallet_id: c.walletId }),
  decide: (wallet, c, { now }) => (wallet.closed ? fail(new WalletIsClosed({ walletId: c.walletId })) : emit(Welcomed({ ...c, at: now })))
});
const WelcomeOnOpen = defineAutomation("welcome-on-open", Welcome).on(WalletOpened, (d) => (d.owner === "" ? undefined : { walletId: d.walletId, owner: d.owner }));

describe("automationScenario: given the log, when the triggers are appended, then what the automation asked for and what its command did", () => {
  test("a trigger asks for its command's input, and the command runs on the log, caused by the trigger", async () => {
    const s = automationScenario(WelcomeOnOpen).given();
    const result = await s.when(WalletOpened({ walletId: "w1", owner: "ann" }));
    expect(result.inputs).toEqual([{ walletId: "w1", owner: "ann" }]);
    expect(result.runs.map((r) => r.result.outcome)).toEqual(["created"]);
    expect(result.events.map((e) => e.type)).toEqual(["Welcomed"]);
    expect(result.events[0]!.causationId).toBe(result.runs[0]!.trigger.position);
    expect(s.scenario.log.map((e) => e.type)).toEqual(["WalletOpened", "Welcomed"]);
  });

  test("a redelivery of the same triggers appends nothing more", async () => {
    const s = automationScenario(WelcomeOnOpen).given();
    await s.when(WalletOpened({ walletId: "w1", owner: "ann" }), WalletOpened({ walletId: "w2", owner: "bob" }));
    const again = await s.redeliver();
    expect(again.inputs).toHaveLength(2);
    expect(again.runs.map((r) => r.result.outcome)).toEqual(["idempotent", "idempotent"]);
    expect(again.events).toEqual([]);
  });

  test("a handler that asks for nothing runs nothing, and an event the automation does not handle asks for nothing", async () => {
    const s = automationScenario(WelcomeOnOpen).given();
    const result = await s.when(WalletOpened({ walletId: "w1", owner: "" }), WalletClosed({ walletId: "w1" }));
    expect(result).toEqual({ inputs: [], runs: [], events: [] });
  });

  test("the command decides on the given log: a domain error is the run's typed result, not a throw", async () => {
    const result = await automationScenario(WelcomeOnOpen).given(WalletClosed({ walletId: "w1" })).when(WalletOpened({ walletId: "w1", owner: "ann" }));
    const run = result.runs[0]!;
    expect(run.result.outcome).toBe("failed");
    expect(run.result.error).toBeInstanceOf(WalletIsClosed);
    expect(result.events).toEqual([]);
  });

  test("later whens see earlier ones' effects: a second wallet opened with the same id is not welcomed twice", async () => {
    const s = automationScenario(WelcomeOnOpen).given();
    await s.when(WalletOpened({ walletId: "w1", owner: "ann" }));
    const second = await s.when(WalletOpened({ walletId: "w1", owner: "ann" }));
    expect(second.runs.map((r) => r.result.outcome)).toEqual(["idempotent"]);
  });

  test("`at` fixes the clock the command decides with", async () => {
    const now = DateTime.makeUnsafe("2026-11-27T12:00:00Z");
    const result = await automationScenario(WelcomeOnOpen).given().at(now).when(WalletOpened({ walletId: "w1", owner: "ann" }));
    expect(Welcomed.decode(result.events[0]!.data).at).toEqual(now);
  });

  test("a trigger the automation cannot decode fails the spec, naming the event (it fails the batch in production)", async () => {
    const Broken = defineEvent("WalletOpened", { schema: Schema.Struct({ walletId: Schema.Number }), tags: () => ({}) });
    await expect(automationScenario(WelcomeOnOpen).given().when(Broken({ walletId: 1 }))).rejects.toThrow(/welcome-on-open.*WalletOpened at position/su);
  });
});
