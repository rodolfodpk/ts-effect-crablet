import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Schema from "effect/Schema";
import { defineEvent } from "../src/Event.ts";
import { defineModel } from "../src/Model.ts";
import { assertModelImpact, baselineOf, eventFactsFromFixtures, formatImpactReport, loadBaseline, modelFactsOf, modelImpact, saveBaseline, type EventFacts, type ModelFacts } from "../src/ModelImpact.ts";

const Opened = defineEvent("Opened", { schema: Schema.Struct({ walletId: Schema.String }), tags: (d) => ({ wallet_id: d.walletId }) });
const Deposited = defineEvent("Deposited", { schema: Schema.Struct({ walletId: Schema.String, depositId: Schema.String }), tags: (d) => ({ wallet_id: d.walletId, deposit_id: d.depositId }) });
const Welcomed = defineEvent("Welcomed", { schema: Schema.Struct({ walletId: Schema.String }), tags: (d) => ({ wallet_id: d.walletId }) });
const Transferred = defineEvent("Transferred", { schema: Schema.Struct({ from: Schema.String, to: Schema.String }), tags: (d) => ({ from_wallet_id: d.from, to_wallet_id: d.to }) });

const events: ReadonlyArray<EventFacts> = [
  { type: "Opened", tagKeys: ["wallet_id"] },
  { type: "Deposited", tagKeys: ["deposit_id", "wallet_id"] },
  { type: "Welcomed", tagKeys: ["wallet_id"] },
  { type: "Transferred", tagKeys: ["from_wallet_id", "to_wallet_id"] }
];
const model = (name: string, handles: string[], ignores: string[], bindings: string[]): ModelFacts => ({ name, handles, ignores, bindings });
const WHY = "A welcome message says nothing about the balance.";
const reviewed = (entries: ReadonlyArray<{ model: string; eventType: string }>) => entries.map((e) => ({ ...e, reason: WHY }));

describe("modelImpact", () => {
  test("an event that carries a binding tag of a model that neither handles nor ignores it is a finding, with the key it came through", () => {
    const r = modelImpact({ events, models: [model("balance", ["Opened", "Deposited"], [], ["wallet_id"])] });
    expect(r.findings).toEqual([{ model: "balance", eventType: "Welcomed", via: ["wallet_id"] }]);
    expect(r.ok).toBe(false);
    expect(r.newFindings).toEqual(r.findings);
  });

  test("handling it or ignoring it accounts for it; an event that carries none of the model's tags is never a finding", () => {
    const handled = model("a", ["Opened", "Deposited", "Welcomed"], [], ["wallet_id"]);
    const ignored = model("b", ["Opened", "Deposited"], ["Welcomed"], ["wallet_id"]);
    expect(modelImpact({ events, models: [handled, ignored] }).findings).toEqual([]);
    // Transferred is bound by other keys, so a wallet_id model does not need to know about it
    expect(modelImpact({ events, models: [model("c", ["Opened", "Deposited", "Welcomed"], [], ["wallet_id"])] }).ok).toBe(true);
  });

  test("a second binding key widens what a model must account for", () => {
    const r = modelImpact({ events, models: [model("m", ["Opened", "Deposited", "Welcomed"], [], ["wallet_id", "from_wallet_id"])] });
    expect(r.findings.map((f) => [f.eventType, f.via])).toEqual([["Transferred", ["from_wallet_id"]]]);
  });

  test("a baseline accepts the pairs already reviewed: only NEW findings fail", () => {
    const m = model("balance", ["Opened", "Deposited"], [], ["wallet_id"]);
    const accepted = modelImpact({ events, models: [m] });
    const baseline = reviewed(baselineOf(accepted));
    expect(modelImpact({ events, models: [m], baseline }).ok).toBe(true);
    // a new event arrives that carries wallet_id
    const added: ReadonlyArray<EventFacts> = [...events, { type: "DepositReversed", tagKeys: ["deposit_id", "wallet_id"] }];
    const r = modelImpact({ events: added, models: [m], baseline });
    expect(r.newFindings.map((f) => f.eventType)).toEqual(["DepositReversed"]);
    expect(r.ok).toBe(false);
    expect(formatImpactReport(r)).toContain("NEW  balance: event DepositReversed carries wallet_id");
  });

  test("a baseline entry that is no longer a finding is STALE and fails, so the pair cannot regress silently", () => {
    const resolved = model("balance", ["Opened", "Deposited"], ["Welcomed"], ["wallet_id"]);
    const r = modelImpact({ events, models: [resolved], baseline: reviewed([{ model: "balance", eventType: "Welcomed" }]) });
    expect(r.findings).toEqual([]);
    expect(r.staleBaseline.map((b) => b.eventType)).toEqual(["Welcomed"]);
    expect(r.ok).toBe(false);
    expect(formatImpactReport(r)).toContain("STALE baseline entry balance / Welcomed");
  });

  test("an accepted pair must say WHY: a blank, missing or token reason is unexplained and fails", () => {
    const m = model("balance", ["Opened", "Deposited"], [], ["wallet_id"]);
    for (const reason of ["", "   ", "n/a", "todo", "ok fine"]) {
      const r = modelImpact({ events, models: [m], baseline: [{ model: "balance", eventType: "Welcomed", reason }] });
      expect(r.findings.length).toBe(1);
      expect(r.newFindings).toEqual([]);
      expect(r.unexplained.map((b) => b.eventType)).toEqual(["Welcomed"]);
      expect(r.ok).toBe(false);
    }
    const good = modelImpact({ events, models: [m], baseline: [{ model: "balance", eventType: "Welcomed", reason: "A welcome message does not change the balance." }] });
    expect(good.ok).toBe(true);
    expect(formatImpactReport(modelImpact({ events, models: [m], baseline: [{ model: "balance", eventType: "Welcomed", reason: "" }] }))).toContain("UNEXPLAINED baseline entry balance / Welcomed");
  });

  test("refreshing the baseline keeps the reasons already written and leaves NEW pairs blank", () => {
    const m = model("balance", ["Opened"], [], ["wallet_id"]);
    const before = modelImpact({ events, models: [m] });
    const written = baselineOf(before).map((b) => (b.eventType === "Deposited" ? { ...b, reason: "Deposits are folded by another model." } : b));
    const added: ReadonlyArray<EventFacts> = [...events, { type: "DepositReversed", tagKeys: ["wallet_id"] }];
    const refreshed = baselineOf(modelImpact({ events: added, models: [m], baseline: written }), written);
    expect(Object.fromEntries(refreshed.map((b) => [b.eventType, b.reason]))).toEqual({ Deposited: "Deposits are folded by another model.", Welcomed: "", DepositReversed: "" });
  });

  test("a model with no metadata is never reported", () => {
    expect(modelFactsOf("legacy", { query: { items: [] }, load: undefined as never })).toEqual({ name: "legacy", handles: [], ignores: [], bindings: [] });
  });
});

describe("facts from real models and fixtures", () => {
  test("a model instance exposes what the report needs, so no declaration is repeated for it", () => {
    const m = defineModel({ by: "wallet_id", initial: () => ({ n: 0 }) })
      .lifecycle(Opened, (s) => s)
      .on(Deposited, (s) => s)
      .on(Transferred, (s) => s, { by: ["from_wallet_id", "to_wallet_id"] })
      .ignores(Welcomed);
    expect(modelFactsOf("wallet", m.of({ id: "w" }))).toEqual({ name: "wallet", handles: ["Opened", "Deposited", "Transferred"], ignores: ["Welcomed"], bindings: ["wallet_id", "from_wallet_id", "to_wallet_id"] });
  });

  test("event facts from fixtures use only the tags DERIVED from the payload, not scope tags added at write time", () => {
    const facts = eventFactsFromFixtures([Opened, Deposited], [
      { type: "Opened", payload: { walletId: "w" }, tags: ["wallet_id=w"] },
      { type: "Deposited", payload: { walletId: "w", depositId: "d" }, tags: ["wallet_id=w", "deposit_id=d", "year=2026"], scopeTags: ["year"] }
    ]);
    expect(facts).toEqual([{ type: "Deposited", tagKeys: ["deposit_id", "wallet_id"] }, { type: "Opened", tagKeys: ["wallet_id"] }]);
  });

  test("a definition with no fixture still appears, with no keys (nothing is known about it, so nothing is reported)", () => {
    expect(eventFactsFromFixtures([Opened], [])).toEqual([{ type: "Opened", tagKeys: [] }]);
  });
});

describe("the baseline file and assertModelImpact", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "impact-"));
  const file = path.join(dir, "baseline.json");
  afterEach(() => { delete process.env["UPDATE_MODEL_IMPACT_BASELINE"]; });
  const m = model("balance", ["Opened", "Deposited"], [], ["wallet_id"]);

  test("a missing baseline is empty; save and load round-trip with reasons, one entry per line", () => {
    expect(loadBaseline(path.join(dir, "none.json"))).toEqual([]);
    const entries = [{ model: "a", eventType: "X", reason: "Because it does not change the decision." }, { model: "b", eventType: "Y", reason: "Another good reason here." }];
    saveBaseline(file, entries);
    expect(loadBaseline(file)).toEqual(entries);
    expect(readFileSync(file, "utf8").split("\n").length).toBe(5);
  });

  test("a baseline written before reasons existed loads with blank reasons", () => {
    writeFileSync(file, '[\n  {"model":"a","eventType":"X"}\n]\n');
    expect(loadBaseline(file)).toEqual([{ model: "a", eventType: "X", reason: "" }]);
  });

  test("it throws with the report when a finding is new", () => {
    writeFileSync(file, "[]\n");
    expect(() => assertModelImpact({ events, models: [m], baselineFile: file })).toThrow(/NEW  balance: event Welcomed/);
  });

  test("UPDATE_MODEL_IMPACT_BASELINE=1 writes the new pairs but STILL fails until a reason is written for each: a refresh is not an approval", () => {
    writeFileSync(file, "[]\n");
    process.env["UPDATE_MODEL_IMPACT_BASELINE"] = "1";
    expect(() => assertModelImpact({ events, models: [m], baselineFile: file })).toThrow(/UNEXPLAINED baseline entry balance \/ Welcomed/);
    delete process.env["UPDATE_MODEL_IMPACT_BASELINE"];
    expect(loadBaseline(file)).toEqual([{ model: "balance", eventType: "Welcomed", reason: "" }]);
    // a person writes the reason; the check passes, and a later refresh keeps it
    saveBaseline(file, [{ model: "balance", eventType: "Welcomed", reason: "A welcome message does not change the balance." }]);
    expect(() => assertModelImpact({ events, models: [m], baselineFile: file })).not.toThrow();
    process.env["UPDATE_MODEL_IMPACT_BASELINE"] = "1";
    expect(() => assertModelImpact({ events, models: [m], baselineFile: file })).not.toThrow();
    expect(loadBaseline(file)[0]!.reason).toBe("A welcome message does not change the balance.");
  });
});

describe("eventFactsFromFixtures: a fixture that cannot be read is skipped here (the fixtures check reports it)", () => {
  test("its tag keys are not counted, and nothing throws", () => {
    const facts = eventFactsFromFixtures([Opened, Deposited], [
      { type: "Opened", payload: { walletId: "w" }, tags: ["wallet_id=w"] },
      { type: "Deposited", payload: { not: "a deposit" }, tags: [] }
    ]);
    expect(facts).toEqual([{ type: "Deposited", tagKeys: [] }, { type: "Opened", tagKeys: ["wallet_id"] }]);
  });
});
