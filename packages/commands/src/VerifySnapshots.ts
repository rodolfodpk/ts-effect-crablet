import { Effect, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import { EventStore } from "@crablet/eventstore";
import { SnapshotStore, canonicalQuery, type SnapshotRow, type SnapshotStoreService } from "@crablet/eventstore/SnapshotStore";
import type { ModelInstance } from "./Model.ts";

// verify-snapshots (ADR-0018): the safety net for the one silent failure of a snapshot, a fold that changed without a `version` bump.
//
// For a random sample of the stored snapshots of each registered model it rebuilds the model instance from the entity stored with the row, loads it twice, once
// as a command would (the snapshot plus the events after it) and once ignoring every snapshot (the whole boundary, folded), and compares the states and the
// positions. It never writes: no collector is in the context, and the second load gets a store that has nothing.
//
//   const report = await Effect.runPromise(Effect.provide(
//     verifySnapshots({ models: [{ name: "account", instance: (entity) => AccountModel.of(entity as never) }], sample: 200 }),
//     AppLive));
//   console.log(formatSnapshotReport(report));
//   if (!report.ok) process.exit(1);
//
// Meant for CI against a copy of production data, and for operators. A full fold per sampled row costs what a command on a model without a snapshot costs
// (E5), so keep `sample` modest on a large database.

export interface VerifiableModel {
  // the snapshot name the model declares
  readonly name: string;
  // rebuilds the model instance from the arguments stored with the row (`{ id, ...scope }`)
  readonly instance: (entity: unknown) => ModelInstance<any>;
}

export interface VerifyOptions {
  readonly models: ReadonlyArray<VerifiableModel>;
  // rows checked per registered model (default 100), chosen at random
  readonly sample?: number;
  // a mismatch is loaded again this many times before it is reported, because a command appending between the two loads is not a bug (default 3)
  readonly attempts?: number;
}

export type ProblemKind =
  | "mismatch" // the snapshot plus its tail does not equal the full fold: the fold changed without a version bump, or it is not deterministic
  | "undecodable" // the stored state no longer decodes with the model's schema: it is ignored on every load
  | "stale_boundary" // the model's boundary query changed since the row was written: the row is never read again
  | "unverifiable" // no entity stored (written before V10): cannot be rebuilt
  | "failed"; // loading raised an error

export interface Problem {
  readonly kind: ProblemKind;
  readonly entity: unknown;
  readonly detail: string;
}

export interface ModelReport {
  readonly name: string;
  readonly version: number | null;
  readonly checked: number;
  readonly problems: ReadonlyArray<Problem>;
}

export interface SnapshotReport {
  readonly rows: ReadonlyArray<{ readonly name: string; readonly version: number; readonly count: number }>;
  readonly models: ReadonlyArray<ModelReport>;
  // stored (name, version) pairs no registered model accounts for: another application's, a renamed model, or an old version awaiting a prune
  readonly unaccounted: ReadonlyArray<{ readonly name: string; readonly version: number; readonly count: number }>;
  // false when any problem other than `unverifiable` was found
  readonly ok: boolean;
}

const nothing: SnapshotStoreService = {
  get: () => Effect.succeed(null),
  save: () => Effect.succeed(false),
  list: () => Effect.succeed([]),
  summary: Effect.succeed([]),
  fingerprint: (canonical) => Effect.succeed(canonical),
  pruneOtherVersions: () => Effect.succeed(0)
};

const json = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

const checkRow = (model: VerifiableModel, row: SnapshotRow, attempts: number): Effect.Effect<Problem | null, never, EventStore | SnapshotStore> =>
  Effect.gen(function* () {
    if (row.entity === null) return { kind: "unverifiable", entity: null, detail: "no entity stored with this row (written before V10)" } satisfies Problem;
    const instance = model.instance(row.entity);
    const meta = instance.snapshot;
    if (meta === undefined) return { kind: "failed", entity: row.entity, detail: `the registered model "${model.name}" declares no .snapshot(...)` } satisfies Problem;
    const store = yield* SnapshotStore;
    const es = yield* EventStore;

    if ((yield* store.fingerprint(canonicalQuery(instance.query))) !== row.fingerprint) {
      return { kind: "stale_boundary", entity: row.entity, detail: "the model's boundary query is not the one this row was written for" } satisfies Problem;
    }
    try {
      Schema.decodeUnknownSync(meta.schema as never)(row.state);
    } catch (error) {
      return { kind: "undecodable", entity: row.entity, detail: `stored state ${json(row.state)} does not decode: ${String(error).split("\n")[0]}` } satisfies Problem;
    }

    let last = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const withSnapshot = yield* instance.load(es);
      const full = yield* Effect.provideService(instance.load(es), SnapshotStore, nothing);
      const a = json(withSnapshot.state), b = json(full.state);
      if (a === b && withSnapshot.logPosition.position === full.logPosition.position) return null;
      last = `with the snapshot ${a} at position ${withSnapshot.logPosition.position}; folding the whole boundary ${b} at position ${full.logPosition.position}`;
    }
    return { kind: "mismatch", entity: row.entity, detail: last } satisfies Problem;
  }).pipe(Effect.catchCause((cause) => Effect.succeed({ kind: "failed", entity: row.entity, detail: String(cause).split("\n")[0]! } satisfies Problem)));

export const verifySnapshots = (options: VerifyOptions): Effect.Effect<SnapshotReport, SqlError, EventStore | SnapshotStore> =>
  Effect.gen(function* () {
    const store = yield* SnapshotStore;
    const sample = options.sample ?? 100;
    const attempts = Math.max(1, options.attempts ?? 3);
    const rows = yield* store.summary;
    const models: Array<ModelReport> = [];
    // the version each registered model is at now (read from an instance; the arguments do not matter for this)
    const currentVersion = new Map<string, number>();
    for (const m of options.models) {
      const v = (() => { try { return m.instance({}).snapshot?.version; } catch { return undefined; } })();
      if (v !== undefined) currentVersion.set(m.name, v);
    }
    for (const model of options.models) {
      // only rows of the model's CURRENT version are checked; older ones are never read again and are listed as unaccounted
      const sampled = yield* store.list({ name: model.name, ...(currentVersion.has(model.name) ? { version: currentVersion.get(model.name)! } : {}), limit: sample });
      const problems: Array<Problem> = [];
      for (const row of sampled) {
        const problem = yield* checkRow(model, row, attempts);
        if (problem !== null) problems.push(problem);
      }
      const versions = [...new Set(sampled.map((r) => r.version))];
      models.push({ name: model.name, version: versions.length === 1 ? versions[0]! : null, checked: sampled.length, problems });
    }
    // what the registered models do not account for: other names, and (for a registered name) versions that no sampled row of the current model uses
    const registered = new Set(options.models.map((m) => m.name));
    const unaccounted = rows.filter((r) => !registered.has(r.name) || (currentVersion.has(r.name) && currentVersion.get(r.name) !== r.version));
    return { rows, models, unaccounted, ok: models.every((m) => m.problems.every((p) => p.kind === "unverifiable")) };
  });

export const formatSnapshotReport = (report: SnapshotReport): string => {
  const lines: Array<string> = [];
  lines.push(`snapshots stored: ${report.rows.map((r) => `${r.name} v${r.version} x${r.count}`).join(", ") || "none"}`);
  for (const m of report.models) {
    const bad = m.problems.filter((p) => p.kind !== "unverifiable");
    const unverifiable = m.problems.length - bad.length;
    lines.push(`${m.name}: ${m.checked} checked, ${bad.length === 0 ? "all consistent" : `${bad.length} PROBLEM(S)`}${unverifiable > 0 ? `, ${unverifiable} unverifiable` : ""}`);
    for (const p of bad) lines.push(`  ${p.kind} for ${json(p.entity)}: ${p.detail}`);
  }
  for (const u of report.unaccounted) lines.push(`not accounted for by a registered model's current version: ${u.name} v${u.version} x${u.count} (prune it, or register the model)`);
  lines.push(report.ok ? "OK" : "FAILED");
  return lines.join("\n");
};
