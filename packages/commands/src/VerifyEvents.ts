import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { AppendEvent } from "@crablet/eventstore/AppendEvent";
import { EventDecodingFailure, type DecodingIssue } from "@crablet/eventstore/EventDecoding";

// verify-events (ADR-0017, decision 4): decode what is really STORED, by event type, with the CURRENT definitions, and say which events cannot be read, where in
// the log they are, and what is wrong with them. The fixtures check (testing/EventFixtures) proves a change is compatible with the shapes you remembered to keep;
// this one finds the shapes you forgot, in the data itself. It also reports the tags a definition derives now that the stored event lacks (DCB rule B: a boundary
// on that tag would miss the event) and the event types in the log that no definition accounts for.
//
//   const report = await Effect.runPromise(Effect.provide(
//     verifyEvents({ definitions: [DepositMade, WithdrawalMade, ...], sample: 2000 }),
//     AppLive));
//   console.log(formatEventsReport(report));
//   if (!report.ok) process.exit(1);
//
// Read-only. By default it checks a RANDOM SAMPLE of each type (a full scan costs time proportional to the log: about 476 bytes per event on disk, E8); `all: true`
// walks every event in position order in batches (memory stays one batch). `fromPosition` / `toPosition` (inclusive) and `types` narrow it, which is the way to
// re-check a window after a deploy. Meant for CI against a copy of production data and for operators.

export interface VerifyEventsOptions {
  // the event definitions (`defineEvent(...)` values) of the application
  readonly definitions: ReadonlyArray<unknown>;
  // events checked per type when `all` is not set (default 1,000), chosen at random
  readonly sample?: number;
  // check every event of each type
  readonly all?: boolean;
  // rows per read in `all` mode (default 1,000)
  readonly batchSize?: number;
  readonly fromPosition?: bigint;
  readonly toPosition?: bigint;
  // only these event types
  readonly types?: ReadonlyArray<string>;
  // how many failing positions to list per type (default 20)
  readonly maxPositions?: number;
}

export interface IssueSummary {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
  readonly count: number;
}

export interface TypeEventsReport {
  readonly type: string;
  // events of this type in the range
  readonly total: number;
  readonly checked: number;
  // cannot be decoded by the current definition
  readonly failures: number;
  // the first `maxPositions` of them
  readonly failingPositions: ReadonlyArray<bigint>;
  // what is wrong, most common first
  readonly issues: ReadonlyArray<IssueSummary>;
  // decodable events for which the definition now derives a tag the stored event does not have
  readonly inventedTags: number;
  readonly inventedTagPositions: ReadonlyArray<bigint>;
}

export interface EventsReport {
  readonly types: ReadonlyArray<TypeEventsReport>;
  // event types present in the range that no definition accounts for
  readonly unknownTypes: ReadonlyArray<{ readonly type: string; readonly count: number }>;
  // false when any event cannot be read or any tag drifted. Unknown types are listed, not failed: not every type in a log is read by this application.
  readonly ok: boolean;
}

interface Definition {
  readonly type: string;
  readonly decode: (raw: unknown) => unknown;
}

interface Row {
  readonly position: string;
  readonly tags: ReadonlyArray<string>;
  readonly data: unknown;
}

export const verifyEvents = (options: VerifyEventsOptions): Effect.Effect<EventsReport, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const definitions = new Map((options.definitions as ReadonlyArray<Definition>).map((d) => [d.type, d] as const));
    const sample = options.sample ?? 1_000;
    const batchSize = options.batchSize ?? 1_000;
    const maxPositions = options.maxPositions ?? 20;
    const from = (options.fromPosition ?? 0n).toString();
    const to = (options.toPosition ?? 9_223_372_036_854_775_807n).toString();
    const wanted = options.types === undefined ? null : new Set(options.types);

    const counts = yield* sql.unsafe<{ type: string; n: string }>(
      "SELECT type, count(*) AS n FROM crablet_events WHERE position >= $1::bigint AND position <= $2::bigint GROUP BY type ORDER BY type",
      [from, to]
    );
    const unknownTypes = counts.filter((c) => !definitions.has(c.type) && (wanted === null || wanted.has(c.type))).map((c) => ({ type: c.type, count: Number(c.n) }));
    const totalOf = new Map(counts.map((c) => [c.type, Number(c.n)] as const));

    const reports: Array<TypeEventsReport> = [];
    for (const [type, def] of [...definitions].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (wanted !== null && !wanted.has(type)) continue;
      const total = totalOf.get(type) ?? 0;
      const failing: Array<bigint> = [];
      const invented: Array<bigint> = [];
      let failures = 0;
      let inventedTags = 0;
      let checked = 0;
      const issues = new Map<string, { path: ReadonlyArray<string | number>; message: string; count: number }>();

      const check = (row: Row): void => {
        checked++;
        let decoded: unknown;
        try {
          decoded = def.decode(row.data);
        } catch (error) {
          failures++;
          if (failing.length < maxPositions) failing.push(BigInt(row.position));
          const found: ReadonlyArray<DecodingIssue> = error instanceof EventDecodingFailure ? error.issues : [{ path: [], message: String(error).split("\n")[0]! }];
          for (const issue of found) {
            const key = JSON.stringify([issue.path, issue.message]);
            const seen = issues.get(key);
            issues.set(key, { path: issue.path, message: issue.message, count: (seen?.count ?? 0) + 1 });
          }
          return;
        }
        try {
          const derived = (def as unknown as (data: unknown) => AppendEvent)(decoded).tags.map((t) => `${t.key}=${t.value}`);
          const stored = new Set(row.tags);
          if (derived.some((t) => !stored.has(t))) {
            inventedTags++;
            if (invented.length < maxPositions) invented.push(BigInt(row.position));
          }
        } catch {
          // an event that cannot be rebuilt from its decoded payload (a guard in its definition): its tags cannot be compared, which is not a drift
        }
      };

      if (options.all === true) {
        let last = (BigInt(from) - 1n).toString();
        for (;;) {
          const rows = yield* sql.unsafe<Row>(
            "SELECT position::text AS position, tags, data FROM crablet_events WHERE type = $1 AND position > $2::bigint AND position <= $3::bigint ORDER BY crablet_events.position LIMIT $4", // (qualified: a bare `position` would sort by the text alias above, as text)
            [type, last, to, batchSize]
          );
          for (const row of rows) check(row);
          if (rows.length < batchSize) break;
          last = rows[rows.length - 1]!.position;
        }
      } else {
        const rows = yield* sql.unsafe<Row>(
          "SELECT position::text AS position, tags, data FROM crablet_events WHERE type = $1 AND position >= $2::bigint AND position <= $3::bigint ORDER BY random() LIMIT $4",
          [type, from, to, sample]
        );
        for (const row of rows) check(row);
        failing.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        invented.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      }
      reports.push({
        type,
        total,
        checked,
        failures,
        failingPositions: failing,
        issues: [...issues.values()].sort((a, b) => b.count - a.count),
        inventedTags,
        inventedTagPositions: invented
      });
    }
    return { types: reports, unknownTypes, ok: reports.every((r) => r.failures === 0 && r.inventedTags === 0) };
  });

export const formatEventsReport = (report: EventsReport): string => {
  const lines: Array<string> = [];
  const empty = report.types.filter((t) => t.total === 0);
  for (const t of report.types.filter((t) => t.total > 0)) {
    const scope = t.checked < t.total ? `${t.checked} of ${t.total} checked` : `${t.total} checked`;
    if (t.failures === 0 && t.inventedTags === 0) {
      lines.push(`${t.type}: ${scope}, all readable`);
      continue;
    }
    if (t.failures > 0) {
      const positions = t.failingPositions.map(String).join(", ");
      lines.push(`${t.type}: ${t.failures} of ${t.checked} cannot be read (${scope}); first positions: ${positions}${t.failures > t.failingPositions.length ? ", ..." : ""}`);
      for (const i of t.issues) lines.push(`  ${i.message}${i.path.length > 0 ? ` at ${i.path.join(".")}` : ""} (${i.count})`);
    }
    if (t.inventedTags > 0) {
      lines.push(`${t.type}: ${t.inventedTags} of ${t.checked} lack a tag the definition derives now (a boundary on it would miss them); first positions: ${t.inventedTagPositions.map(String).join(", ")}`);
    }
  }
  if (empty.length > 0) lines.push(`no events in the range for: ${empty.map((t) => t.type).join(", ")}`);
  for (const u of report.unknownTypes) lines.push(`${u.type}: ${u.count} in the log with no definition among the ones given (fine if this application never reads it)`);
  lines.push(report.ok ? "OK" : "FAILED");
  return lines.join("\n");
};
