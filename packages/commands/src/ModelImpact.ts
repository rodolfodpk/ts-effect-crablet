import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import type { EventFixture } from "./testing/EventFixtures.ts";
import type { ModelInstance } from "./Model.ts";

// The change-impact report (ADR-0017, DCB rule A, in the form that suits vertical slices).
//
// A decision model's boundary is built from the event types it handles, so an event type that carries one of its binding tags but is not handled is invisible to its
// fold AND to its conflict check. The risk shows up when an event is ADDED: which models bind by a tag the new event carries and neither handle it nor say they
// ignore it? This report answers that, from data, with no change to the slices themselves (no registry the slices must reference, no boilerplate in each model):
//
//   facts about EVENTS : their type and the tag keys they carry    (from fixtures, or from the log)
//   facts about MODELS : what they handle, ignore and bind by        (the instance exposes them)
//   finding            : a (model, event type) pair where the event carries a binding key of the model and the model accounts for it neither way
//
// Findings are not all bugs: most are "this decision does not care", which is why a committed BASELINE lists the pairs already reviewed, each with the REASON it
// was accepted. The check fails only on
//   - a NEW finding (an event was added, or a model's bindings grew, and nobody has looked),
//   - a STALE baseline entry (it was resolved, e.g. by `.ignores(...)`, and would otherwise let the pair regress unnoticed), and
//   - an UNEXPLAINED baseline entry (no reason, or a token one): accepting a pair has to say why, so refreshing the baseline cannot be a rubber stamp.
// Resolve a new finding by handling the event (`.on`), declaring it (`.ignores`), or, if it really is fine, accepting it into the baseline WITH a reason.

export interface EventFacts {
  readonly type: string;
  readonly tagKeys: ReadonlyArray<string>;
}

export interface ModelFacts {
  readonly name: string;
  readonly handles: ReadonlyArray<string>;
  readonly ignores: ReadonlyArray<string>;
  readonly bindings: ReadonlyArray<string>;
}

export interface Finding {
  readonly model: string;
  readonly eventType: string;
  // the model's binding keys that this event type carries
  readonly via: ReadonlyArray<string>;
}

export interface BaselineEntry {
  readonly model: string;
  readonly eventType: string;
  // why this decision does not need the event (at least MIN_REASON_LENGTH characters); written by a person, kept by every refresh of the baseline
  readonly reason: string;
}

export const MIN_REASON_LENGTH = 12;
export const isExplained = (entry: { readonly reason?: string | undefined }): boolean => (entry.reason ?? "").trim().length >= MIN_REASON_LENGTH;

export interface ImpactReport {
  readonly findings: ReadonlyArray<Finding>;
  // findings nobody has reviewed (not in the baseline): these fail the check
  readonly newFindings: ReadonlyArray<Finding>;
  // baseline entries that are no longer findings: remove them, or the pair could regress silently
  readonly staleBaseline: ReadonlyArray<BaselineEntry>;
  // baseline entries with no real reason
  readonly unexplained: ReadonlyArray<BaselineEntry>;
  readonly ok: boolean;
}

// What a model instance says about itself. A model built without the metadata (an older builder) accounts for nothing and binds by nothing, so it is never reported.
export const modelFactsOf = (name: string, instance: ModelInstance<any>): ModelFacts => ({
  name,
  handles: instance.handles ?? [],
  ignores: instance.ignores ?? [],
  bindings: instance.bindings ?? []
});

// Tag keys per event type, from fixtures: decode the fixture's payload with the definition and build the event, so only the tags DERIVED from the payload count
// (scope tags added with `extraTags`, a period say, are not part of what an event is bound by).
export const eventFactsFromFixtures = (definitions: ReadonlyArray<unknown>, fixtures: ReadonlyArray<EventFixture>): ReadonlyArray<EventFacts> => {
  const keys = new Map<string, Set<string>>();
  const defs = new Map((definitions as ReadonlyArray<{ type: string; decode: (raw: unknown) => unknown }>).map((d) => [d.type, d] as const));
  for (const d of defs.values()) keys.set(d.type, new Set());
  for (const fixture of fixtures) {
    const def = defs.get(fixture.type);
    if (def === undefined) continue;
    try {
      const built = (def as unknown as (data: unknown) => AppendEvent)(def.decode(fixture.payload));
      for (const tag of built.tags) keys.get(fixture.type)!.add(tag.key);
    } catch {
      // an unreadable fixture is reported by the fixtures check, not here
    }
  }
  return [...keys].map(([type, set]) => ({ type, tagKeys: [...set].sort() })).sort((a, b) => (a.type < b.type ? -1 : 1));
};

// Tag keys per event type, from the log: what is really stored (types and keys that exist in the data). Needs the tag index (`crablet_event_tag_keys`).
export const eventFactsFromLog: Effect.Effect<ReadonlyArray<EventFacts>, SqlError, SqlClient.SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql.unsafe<{ type: string; key: string }>(
    "SELECT DISTINCT e.type, t.key FROM crablet_event_tag_keys t JOIN crablet_events e ON e.position = t.position ORDER BY e.type, t.key"
  );
  const byType = new Map<string, Array<string>>();
  for (const r of rows) byType.set(r.type, [...(byType.get(r.type) ?? []), r.key]);
  return [...byType].map(([type, tagKeys]) => ({ type, tagKeys }));
});

const pairKey = (model: string, eventType: string): string => `${model}\u0000${eventType}`;

export const modelImpact = (options: {
  readonly events: ReadonlyArray<EventFacts>;
  readonly models: ReadonlyArray<ModelFacts>;
  readonly baseline?: ReadonlyArray<BaselineEntry>;
}): ImpactReport => {
  const findings: Array<Finding> = [];
  for (const model of options.models) {
    const accounted = new Set([...model.handles, ...model.ignores]);
    for (const event of options.events) {
      if (accounted.has(event.type)) continue;
      const via = event.tagKeys.filter((k) => model.bindings.includes(k));
      if (via.length > 0) findings.push({ model: model.name, eventType: event.type, via });
    }
  }
  const baseline = options.baseline ?? [];
  const known = new Set(baseline.map((b) => pairKey(b.model, b.eventType)));
  const current = new Set(findings.map((f) => pairKey(f.model, f.eventType)));
  const newFindings = findings.filter((f) => !known.has(pairKey(f.model, f.eventType)));
  const staleBaseline = baseline.filter((b) => !current.has(pairKey(b.model, b.eventType)));
  // a stale entry is reported as stale, not also as unexplained
  const unexplained = baseline.filter((b) => current.has(pairKey(b.model, b.eventType)) && !isExplained(b));
  return { findings, newFindings, staleBaseline, unexplained, ok: newFindings.length === 0 && staleBaseline.length === 0 && unexplained.length === 0 };
};

// The baseline that accepts the current findings. A pair that was already in `previous` keeps its reason; a NEW pair gets a blank one, which the check refuses
// until a person writes why.
export const baselineOf = (report: ImpactReport, previous: ReadonlyArray<BaselineEntry> = []): ReadonlyArray<BaselineEntry> => {
  const reasons = new Map(previous.map((b) => [pairKey(b.model, b.eventType), b.reason] as const));
  return report.findings
    .map((f) => ({ model: f.model, eventType: f.eventType, reason: reasons.get(pairKey(f.model, f.eventType)) ?? "" }))
    .sort((a, b) => (pairKey(a.model, a.eventType) < pairKey(b.model, b.eventType) ? -1 : 1));
};

export const formatImpactReport = (report: ImpactReport): string => {
  const lines: Array<string> = [];
  for (const f of report.newFindings) {
    lines.push(`NEW  ${f.model}: event ${f.eventType} carries ${f.via.join(", ")} (a binding tag of the model), and the model neither handles nor ignores it.`);
  }
  if (report.newFindings.length > 0) {
    lines.push("     Decide for each: it changes the decision -> .on(Event, ...) ; it does not -> .ignores(Event) ; reviewed and fine as it is -> add it to the baseline.");
  }
  for (const b of report.staleBaseline) lines.push(`STALE baseline entry ${b.model} / ${b.eventType}: it is no longer a finding; remove it from the baseline so it cannot regress unnoticed.`);
  for (const b of report.unexplained) lines.push(`UNEXPLAINED baseline entry ${b.model} / ${b.eventType}: write why this decision does not need the event (at least ${MIN_REASON_LENGTH} characters) in the "reason" field.`);
  const accepted = report.findings.length - report.newFindings.length;
  lines.push(`${report.findings.length} unaccounted (model, event) pair(s): ${accepted} in the baseline, ${report.newFindings.length} new; ${report.staleBaseline.length} stale and ${report.unexplained.length} unexplained baseline entr${report.staleBaseline.length + report.unexplained.length === 1 ? "y" : "ies"}.`);
  lines.push(report.ok ? "OK" : "FAILED");
  return lines.join("\n");
};

// Baseline file: a JSON array of { model, eventType, reason }, sorted, one per line so a review sees exactly which pairs were accepted and why. A file written before
// reasons existed loads with blank reasons (so every entry is unexplained until someone writes it). (Node only: test tooling.)
export const loadBaseline = (file: string): ReadonlyArray<BaselineEntry> =>
  existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as ReadonlyArray<{ model: string; eventType: string; reason?: string }>).map((e) => ({ model: e.model, eventType: e.eventType, reason: e.reason ?? "" }))
    : [];
export const saveBaseline = (file: string, entries: ReadonlyArray<BaselineEntry>): void =>
  writeFileSync(file, `[\n${entries.map((e) => `  ${JSON.stringify({ model: e.model, eventType: e.eventType, reason: e.reason })}`).join(",\n")}\n]\n`);

// For a test: throws with the report when it fails. With UPDATE_MODEL_IMPACT_BASELINE=1 it first rewrites the baseline to the current findings (keeping the
// reasons already written, blank for new pairs) and then runs the check, which FAILS until every new pair has a reason: refreshing the baseline is not enough to
// make the test pass. Review the diff of that file: it is the list of accepted pairs and why.
export const assertModelImpact = (options: {
  readonly events: ReadonlyArray<EventFacts>;
  readonly models: ReadonlyArray<ModelFacts>;
  readonly baselineFile: string;
}): void => {
  const previous = loadBaseline(options.baselineFile);
  let report = modelImpact({ events: options.events, models: options.models, baseline: previous });
  if (process.env["UPDATE_MODEL_IMPACT_BASELINE"] === "1") {
    const updated = baselineOf(report, previous);
    saveBaseline(options.baselineFile, updated);
    report = modelImpact({ events: options.events, models: options.models, baseline: updated });
  }
  if (!report.ok) throw new Error(`model impact:\n${formatImpactReport(report)}\n(UPDATE_MODEL_IMPACT_BASELINE=1 rewrites ${options.baselineFile} to the current findings; then write the reasons)`);
};
