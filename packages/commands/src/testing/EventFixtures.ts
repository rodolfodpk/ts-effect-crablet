import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import { EventDecodingFailure, describeIssues } from "@crablet/eventstore/EventDecoding";

// Fixtures for event evolution (ADR-0017, decision 4). The log holds every shape an event has ever been written in, so each event type keeps, as test data,
// the payloads it was once written with AND the tags that were stored with them, and a test asserts that the CURRENT definition still
//   - decodes every one of them (a rename, a removed field or a new required field makes an old payload undecodable), and
//   - derives from the decoded payload no tag the stored event lacks (a boundary on that tag would miss the old event: DCB rule B, tags are additive-only), and
//     loses none that was stored (the tags function stopped deriving one).
//
//   test("every shape an event was written in is still readable", () =>
//     assertEventFixtures({ definitions: [DepositMade, WithdrawalMade], fixtures: loadEventFixtures("test/fixtures/events"), requireCoverage: true }));
//
// Before changing an event's shape, capture a payload of the OLD shape (`fixtureOf(storedEvent)`, or copy one from the database) and add it to the fixtures: it is
// what proves the change is compatible. `verify-events` (ADR-0017 step 4) runs the same check over what is really stored.

export interface EventFixture {
  readonly type: string;
  // the stored payload, as JSON
  readonly payload: unknown;
  // the tags stored with it, as "key=value" (keys lower-case)
  readonly tags: ReadonlyArray<string>;
  // keys of stored tags that come from outside the payload (`defineEvent`'s `extraTags`, e.g. a period): they are allowed to be stored without being derived
  readonly scopeTags?: ReadonlyArray<string>;
  readonly note?: string;
}

// What the check needs of an event definition (an `EventDef` has all of it): its type, its reader, and calling it builds the event (with its tags).
interface FixtureDefinition {
  readonly type: string;
  readonly decode: (raw: unknown) => unknown;
}

export interface FixtureProblem {
  readonly type: string;
  readonly kind: "no_definition" | "undecodable" | "invented_tag" | "lost_tag" | "cannot_build";
  readonly detail: string;
  readonly note?: string;
}

export interface FixtureReport {
  readonly checked: number;
  readonly problems: ReadonlyArray<FixtureProblem>;
  // event types with a definition but no fixture at all
  readonly uncovered: ReadonlyArray<string>;
}

const tagStrings = (event: AppendEvent): ReadonlyArray<string> => event.tags.map((t) => `${t.key}=${t.value}`);

export const checkEventFixtures = (options: { readonly definitions: ReadonlyArray<unknown>; readonly fixtures: ReadonlyArray<EventFixture> }): FixtureReport => {
  const defs = new Map((options.definitions as ReadonlyArray<FixtureDefinition>).map((d) => [d.type, d] as const));
  const problems: Array<FixtureProblem> = [];
  const covered = new Set<string>();
  for (const fixture of options.fixtures) {
    const base = { type: fixture.type, ...(fixture.note === undefined ? {} : { note: fixture.note }) };
    const def = defs.get(fixture.type);
    if (def === undefined) {
      problems.push({ ...base, kind: "no_definition", detail: `no definition for event type "${fixture.type}": the log still holds it, so the code that reads it must stay` });
      continue;
    }
    covered.add(fixture.type);
    let decoded: unknown;
    try {
      decoded = def.decode(fixture.payload);
    } catch (error) {
      problems.push({ ...base, kind: "undecodable", detail: error instanceof EventDecodingFailure ? `a payload written before cannot be read: ${describeIssues(error.issues)}` : `decoding raised: ${String(error)}` });
      continue;
    }
    let derived: ReadonlyArray<string>;
    try {
      derived = tagStrings((def as unknown as (data: unknown) => AppendEvent)(decoded));
    } catch (error) {
      problems.push({ ...base, kind: "cannot_build", detail: `the decoded payload cannot be turned back into an event: ${String(error).split("\n")[0]}` });
      continue;
    }
    const stored = new Set(fixture.tags);
    const scope = new Set(fixture.scopeTags ?? []);
    for (const tag of derived) {
      if (!stored.has(tag)) problems.push({ ...base, kind: "invented_tag", detail: `the definition now derives ${tag}, which this stored event does not have: a boundary on it would miss the event` });
    }
    for (const tag of stored) {
      if (!derived.includes(tag) && !scope.has(tag.slice(0, tag.indexOf("=")))) problems.push({ ...base, kind: "lost_tag", detail: `the stored tag ${tag} is no longer derived from the payload` });
    }
  }
  const uncovered = [...defs.keys()].filter((t) => !covered.has(t)).sort();
  return { checked: options.fixtures.length, problems, uncovered };
};

export const formatFixtureReport = (report: FixtureReport): string =>
  [
    ...report.problems.map((p) => `${p.type} (${p.kind}): ${p.detail}${p.note ? ` [fixture: ${p.note}]` : ""}`),
    ...report.uncovered.map((t) => `${t}: no fixture (add one for the shape it is written in now, so a later change has something to be checked against)`)
  ].join("\n");

// Throws, listing every problem, when a fixture is no longer readable or its tags drifted; with `requireCoverage` also when an event type has no fixture.
export const assertEventFixtures = (options: { readonly definitions: ReadonlyArray<unknown>; readonly fixtures: ReadonlyArray<EventFixture>; readonly requireCoverage?: boolean }): void => {
  const report = checkEventFixtures(options);
  const uncovered = options.requireCoverage === true ? report.uncovered : [];
  if (report.problems.length > 0 || uncovered.length > 0) throw new Error(`event fixtures:\n${formatFixtureReport({ ...report, uncovered })}`);
};

// A fixture from an event read out of the log (or from a hand-built StoredEvent): its payload and the tags it was stored with.
export const fixtureOf = (event: { readonly type: string; readonly data: unknown; readonly tags: ReadonlyArray<{ readonly key: string; readonly value: string }> }, options: { readonly scopeTags?: ReadonlyArray<string>; readonly note?: string } = {}): EventFixture => ({
  type: event.type,
  payload: JSON.parse(JSON.stringify(event.data)),
  tags: event.tags.map((t) => `${t.key}=${t.value}`),
  ...(options.scopeTags === undefined ? {} : { scopeTags: options.scopeTags }),
  ...(options.note === undefined ? {} : { note: options.note })
});

// Every `*.json` file of a directory, each holding one fixture or an array of them. Files are read in name order. (Node only: this is test tooling.)
export const loadEventFixtures = (directory: string): ReadonlyArray<EventFixture> =>
  readdirSync(directory)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => {
      const parsed = JSON.parse(readFileSync(path.join(directory, f), "utf8")) as EventFixture | ReadonlyArray<EventFixture>;
      return Array.isArray(parsed) ? parsed : [parsed as EventFixture];
    });
