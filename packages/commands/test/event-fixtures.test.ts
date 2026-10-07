import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { defineEvent } from "../src/Event.ts";
import { assertEventFixtures, checkEventFixtures, fixtureOf, formatFixtureReport, loadEventFixtures, type EventFixture } from "../src/testing/EventFixtures.ts";

// "Deposit" as it was first written, and the fixture of that shape: the payload and the tags that were stored
const first: EventFixture = { type: "Deposit", payload: { id: "a", amount: 5 }, tags: ["deposit_id=a"], note: "v1, the first release" };

const V1 = Schema.Struct({ id: Schema.String, amount: Schema.Number });
const V2 = Schema.Struct({ id: Schema.String, amount: Schema.Number, fee: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))) });
const kinds = (definitions: ReadonlyArray<unknown>, fixtures: ReadonlyArray<EventFixture>) => checkEventFixtures({ definitions, fixtures }).problems.map((p) => p.kind);

describe("checkEventFixtures", () => {
  test("the shape an event is written in passes, and so does a compatible change (a field added with a default that no tag uses)", () => {
    const v1 = defineEvent("Deposit", { schema: V1, tags: (d) => ({ deposit_id: d.id }) });
    const v2 = defineEvent("Deposit", { schema: V2, tags: (d) => ({ deposit_id: d.id }) });
    expect(checkEventFixtures({ definitions: [v1], fixtures: [first] })).toEqual({ checked: 1, problems: [], uncovered: [] });
    expect(checkEventFixtures({ definitions: [v2], fixtures: [first] }).problems).toEqual([]);
  });

  test("a tag derived from a defaulted field is reported: the old event does not carry it, so a boundary on it would miss the event (DCB rule B)", () => {
    const v2 = defineEvent("Deposit", { schema: V2, tags: (d) => ({ deposit_id: d.id, fee_class: d.fee > 0 ? "paid" : "free" }) });
    const report = checkEventFixtures({ definitions: [v2], fixtures: [first] });
    expect(report.problems.map((p) => p.kind)).toEqual(["invented_tag"]);
    expect(report.problems[0]!.detail).toContain("fee_class=free");
    expect(formatFixtureReport(report)).toContain("[fixture: v1, the first release]");
  });

  test("a rename, a removed field or a new required field is reported as unreadable, with the paths", () => {
    const renamed = defineEvent("Deposit", { schema: Schema.Struct({ depositId: Schema.String, amount: Schema.Number }), tags: (d) => ({ deposit_id: d.depositId }) });
    const required = defineEvent("Deposit", { schema: Schema.Struct({ id: Schema.String, amount: Schema.Number, currency: Schema.String }), tags: (d) => ({ deposit_id: d.id }) });
    expect(kinds([renamed], [first])).toEqual(["undecodable"]);
    expect(checkEventFixtures({ definitions: [required], fixtures: [first] }).problems[0]!.detail).toContain("Missing key at currency");
  });

  test("a tag that was stored and is no longer derived is reported; a scope tag (added with extraTags, not from the payload) is allowed", () => {
    const dropped = defineEvent("Deposit", { schema: V1, tags: () => ({}) });
    expect(kinds([dropped], [first])).toEqual(["lost_tag"]);
    const same = defineEvent("Deposit", { schema: V1, tags: (d) => ({ deposit_id: d.id }) });
    expect(kinds([same], [{ ...first, tags: ["deposit_id=a", "year=2026"] }])).toEqual(["lost_tag"]);
    expect(kinds([same], [{ ...first, tags: ["deposit_id=a", "year=2026"], scopeTags: ["year"] }])).toEqual([]);
  });

  test("an event type that no longer has a definition is reported: the log still holds it", () => {
    const other = defineEvent("Other", { schema: V1, tags: () => ({}) });
    const report = checkEventFixtures({ definitions: [other], fixtures: [first] });
    expect(report.problems.map((p) => p.kind)).toEqual(["no_definition"]);
    expect(report.uncovered).toEqual(["Other"]);
  });

  test("a definition with no fixture is listed as uncovered", () => {
    const v1 = defineEvent("Deposit", { schema: V1, tags: (d) => ({ deposit_id: d.id }) });
    const other = defineEvent("Other", { schema: V1, tags: () => ({}) });
    expect(checkEventFixtures({ definitions: [v1, other], fixtures: [first] }).uncovered).toEqual(["Other"]);
  });

  test("every old shape is checked: two fixtures of one type, one still readable and one not", () => {
    const v2 = defineEvent("Deposit", { schema: V2, tags: (d) => ({ deposit_id: d.id }) });
    const broken: EventFixture = { type: "Deposit", payload: { amount: 5 }, tags: ["deposit_id=a"], note: "v0: had no id" };
    const report = checkEventFixtures({ definitions: [v2], fixtures: [first, { ...first, payload: { id: "b", amount: 1, fee: 2 }, tags: ["deposit_id=b"] }, broken] });
    expect(report.checked).toBe(3);
    expect(report.problems.map((p) => [p.kind, p.note])).toEqual([["undecodable", "v0: had no id"]]);
  });
});

describe("assertEventFixtures", () => {
  const v1 = defineEvent("Deposit", { schema: V1, tags: (d) => ({ deposit_id: d.id }) });
  const other = defineEvent("Other", { schema: V1, tags: () => ({}) });

  test("returns when everything checks out, and says every problem when not", () => {
    expect(() => assertEventFixtures({ definitions: [v1], fixtures: [first] })).not.toThrow();
    const renamed = defineEvent("Deposit", { schema: Schema.Struct({ depositId: Schema.String }), tags: () => ({}) });
    expect(() => assertEventFixtures({ definitions: [renamed], fixtures: [first] })).toThrow(/Deposit \(undecodable\)/);
  });

  test("requireCoverage makes an event type without a fixture a failure; without it, it is only reported", () => {
    expect(() => assertEventFixtures({ definitions: [v1, other], fixtures: [first] })).not.toThrow();
    expect(() => assertEventFixtures({ definitions: [v1, other], fixtures: [first], requireCoverage: true })).toThrow(/Other: no fixture/);
  });
});

describe("capturing and loading fixtures", () => {
  test("fixtureOf takes the payload and the stored tags from an event read out of the log", () => {
    expect(fixtureOf({ type: "Deposit", data: { id: "a", amount: 5 }, tags: [{ key: "deposit_id", value: "a" }] }, { note: "captured" })).toEqual({ ...first, note: "captured" });
  });

  test("loadEventFixtures reads every .json file of a directory, one fixture or an array each, in name order, and ignores other files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fixtures-"));
    writeFileSync(path.join(dir, "b.json"), JSON.stringify([{ ...first, note: "b1" }, { ...first, note: "b2" }]));
    writeFileSync(path.join(dir, "a.json"), JSON.stringify({ ...first, note: "a" }));
    writeFileSync(path.join(dir, "readme.md"), "not a fixture");
    expect(loadEventFixtures(dir).map((f) => f.note)).toEqual(["a", "b1", "b2"]);
  });
});
