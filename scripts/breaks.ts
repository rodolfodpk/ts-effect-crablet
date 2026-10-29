// Mutation testing, tier 2 (docs/history/plans/mutation-testing.md, step 4): deliberate breaks of the database-bound code, which the Bun unit tests do not reach and
// Stryker's runner cannot drive. Each break is data: a file, a text that must occur in it exactly once, what to put instead, and the integration tests that must
// then fail. The runner applies one break at a time, runs those tests under Node (Testcontainers, so Docker must be up), and restores the file, also on
// Ctrl-C. Do not edit the sources while it runs; if it is killed outright, `git checkout packages` puts the broken file back.
//
//   bun run breaks                    # every break; exit 1 if one survives, or if a break's text is no longer in its file
//   bun run breaks -- --only a,b      # the breaks with these ids
//   bun run breaks -- --list          # the ids, the files and why each matters
//
// First it runs the tests once with nothing broken: a test that already fails would make every break look caught. Add a break whenever a bug is found in this
// code: the break that would have caused it. A break that survives is a gap in the integration tests; close it with a test, never by removing the break.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface Break {
  readonly id: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  // integration test files (repository-relative) of which at least one must fail
  readonly tests: ReadonlyArray<string>;
  readonly why: string;
}

const es = (f: string) => `packages/eventstore/test/integration/${f}.test.ts`;
const cmd = (f: string) => `packages/commands/test/integration/${f}.test.ts`;
const ep = (f: string) => `packages/event-poller/test/integration/${f}.test.ts`;
const SQL = "packages/eventstore/src/internal/sql.ts";
const POLLER_SQL = "packages/event-poller/src/internal/sql.ts";
const TRACKER = "packages/event-poller/src/PostgresProgressTracker.ts";
const migration = (name: string) => `packages/db-migrations/sql/${name}.sql`;
// The conditional append and its helpers, all in one file (ADR-0047): append_events_if, append_events_batch, crablet_items_match_any,
// crablet_writer_lock_keys. A break's text must occur once in the whole file, so it names enough of its function to be unique.
const APPEND = migration("V2__crablet_append");

export const breaks: ReadonlyArray<Break> = [
  // The append: what the client sends and how it reads the answer (eventstore/src/internal/sql.ts).
  {
    id: "duplicate-as-conflict",
    file: SQL,
    find: `return result.error_code === "IDEMPOTENCY_VIOLATION"`,
    replace: `return result.error_code === "NO_SUCH_CODE"`,
    tests: [es("conformance-postgres"), cmd("repeat-postgres")],
    why: "a repeated request would be reported as a conflict and retried, not answered as the earlier one"
  },
  {
    id: "cursor-without-transaction",
    file: SQL,
    find: "concurrencyItems === null ? null : (condition.afterPosition.transactionId ?? null),",
    replace: "null,",
    tests: [es("append-cursor-inversion"), es("union-boundary-cursor"), es("conformance-postgres")],
    why: "the condition's cursor compared by position only: an event committed later at a lower position is missed (ADR-0016)"
  },
  {
    id: "tags-unquoted",
    file: SQL,
    find: "const quote = (s: string) => `\"${s.replaceAll(\"\\\\\", \"\\\\\\\\\").replaceAll('\"', '\\\\\"')}\"`;",
    replace: "const quote = (s: string) => s;",
    tests: [es("append"), es("conformance-postgres")],
    why: "a tag value with a comma or a quote is stored as other tags"
  },
  {
    id: "empty-condition-items-kept",
    file: SQL,
    find: "    .filter((i) => i.eventTypes.length > 0 || i.tags.length > 0)\n",
    replace: "",
    tests: [es("conformance-postgres"), es("append-multi-item")],
    why: "an item with neither types nor tags would match every event: every append would conflict"
  },
  {
    id: "read-cursor-inclusive",
    file: SQL,
    find: "positionClause = `(transaction_id, position) > ($",
    replace: "positionClause = `(transaction_id, position) >= ($",
    tests: [es("conformance-postgres"), es("project-horizon"), cmd("all-union-cursor-postgres")],
    why: "a model built from a cursor would read the cursor's own event twice"
  },
  {
    id: "query-items-and",
    file: SQL,
    find: `clauses.join(" OR ")`,
    replace: `clauses.join(" AND ")`,
    tests: [es("conformance-postgres"), cmd("dcb-examples-postgres")],
    why: "a query's items are alternatives; with AND a model of two items reads nothing"
  },
  {
    id: "read-order-by-position",
    file: SQL,
    find: "ORDER BY crablet_events.transaction_id, position ASC",
    replace: "ORDER BY position ASC",
    tests: [es("append-cursor-inversion")],
    why: "the events come back out of the order their cursor is taken in, so the next cursor skips some"
  },
  {
    id: "every-event-settled",
    file: SQL,
    find: "(transaction_id < pg_snapshot_xmin(pg_current_snapshot())) AS settled",
    replace: "true AS settled",
    tests: [es("append-cursor-inversion"), es("project-horizon"), es("union-boundary-cursor")],
    why: "a model's horizon would move past events of transactions still running"
  },
  {
    id: "fingerprint-not-sent",
    file: SQL,
    find: "      requireFresh,\n      fingerprint\n",
    replace: "      requireFresh,\n      null\n",
    tests: [cmd("repeat-postgres"), cmd("trigger-backstop-postgres")],
    why: "a repeated request could not be told from a different one, and the trigger backstop would never hold (ADR-0034, ADR-0035)"
  },
  {
    id: "crb01-not-a-defect",
    file: SQL,
    find: `?.code === "CRB01"`,
    replace: `?.code === "NO_SUCH_CODE"`,
    tests: [cmd("causal-order-postgres")],
    why: "a command run inside a transaction that already wrote would fail as an ordinary SQL error, not as the programming error it is (ADR-0033)"
  },
  {
    id: "find-duplicate-blind",
    file: SQL,
    find: "const json = rows[0]?.duplicate ?? null;",
    replace: "const json = null as DuplicateJson | null;",
    tests: [cmd("command-run"), cmd("transfer-guide-postgres")],
    why: "the executor's check before deciding would never see the earlier request, so a repeat would decide again (ADR-0034)"
  },

  // The SQL functions of the append (the migrations: the last definition of each).
  {
    id: "condition-cursor-inclusive",
    file: APPEND,
    find: "(e.transaction_id, e.position) > (p_after_xid, p_after_position)",
    replace: "(e.transaction_id, e.position) >= (p_after_xid, p_after_position)",
    tests: [es("conformance-postgres"), es("append"), es("append-cursor-inversion")],
    why: "the event a decision was built on would count as a conflict with that decision"
  },
  {
    id: "condition-own-transaction",
    file: APPEND,
    find: "AND (p_after_xid IS NULL OR e.transaction_id IS DISTINCT FROM pg_current_xact_id_if_assigned())",
    replace: "",
    tests: [es("append-cursor-inversion")],
    why: "two appends in one transaction would conflict with each other's events"
  },
  {
    id: "condition-tags-any",
    file: APPEND,
    // the condition check's own line, the one before its LIMIT (crablet_items_duplicate has the same test, for the idempotency report)
    find: "OR e.tags @> v_tags)\n                       LIMIT 1) THEN",
    replace: "OR e.tags && v_tags)\n                       LIMIT 1) THEN",
    tests: [es("differential"), es("conformance-postgres")],
    why: "an item's tags are all required; with any of them, unrelated decisions conflict"
  },
  {
    id: "idempotency-not-checked",
    file: APPEND,
    find: "v_has_duplicate := crablet_items_match_any(p_idempotency_items, NULL, NULL);",
    replace: "v_has_duplicate := FALSE;",
    tests: [es("conformance-postgres"), cmd("repeat-postgres")],
    why: "an idempotent append would store its events twice"
  },
  {
    id: "writer-lock-shared",
    file: APPEND,
    find: "PERFORM pg_advisory_xact_lock(v_lock.k);",
    replace: "PERFORM pg_advisory_xact_lock_shared(v_lock.k);",
    tests: [es("append-writer-locking")],
    why: "two concurrent appends could both pass the same condition (ADR-0029)"
  },
  {
    id: "fresh-transaction-unchecked",
    file: APPEND,
    find: "IF p_require_fresh_transaction AND pg_current_xact_id_if_assigned() IS NOT NULL THEN",
    replace: "IF FALSE THEN",
    tests: [cmd("causal-order-postgres")],
    why: "a command could run in a transaction that already wrote, and its events be delivered before what it read (ADR-0033)"
  },
  {
    id: "no-emit-key",
    file: APPEND,
    find: "THEN encode(p_request_fingerprint, 'hex') || '/' || t.ord END",
    replace: "THEN NULL END",
    tests: [cmd("trigger-backstop-postgres"), "packages/automations/test/integration/automation-idempotency-postgres.test.ts"],
    why: "a trigger handled twice would append its events twice (ADR-0035)"
  },
  {
    id: "no-tag-keys",
    file: APPEND,
    find: "WHERE tag LIKE '%=%'),",
    replace: "WHERE FALSE),",
    tests: [ep("tag-key-strategy-equivalence"), ep("event-processor-integration")],
    why: "a processor selecting by tag key would never see the event"
  },
  {
    id: "no-deadline-row",
    file: APPEND,
    find: "WHERE i.type = 'crablet.DeadlineScheduled')",
    replace: "WHERE FALSE)",
    tests: ["packages/automations/test/integration/deadlines.test.ts"],
    why: "a deadline would be stored and never fire"
  },
  {
    id: "type-only-condition-lock-shared",
    file: APPEND,
    find: "SELECT hashtextextended('T:' || type, 0), TRUE\n         FROM item_shapes s, LATERAL unnest(s.types) AS type\n         WHERE cardinality(s.types) > 0 AND cardinality(s.tags) = 0",
    replace: "SELECT hashtextextended('T:' || type, 0), FALSE\n         FROM item_shapes s, LATERAL unnest(s.types) AS type\n         WHERE cardinality(s.types) > 0 AND cardinality(s.tags) = 0",
    tests: [es("append-writer-locking")],
    why: "a condition on a type with no tags would not exclude a concurrent writer of that type"
  },

  // The poller's queries (event-poller/src/internal/sql.ts).
  {
    id: "poll-unsettled",
    file: POLLER_SQL,
    find: `clauses.push("e.transaction_id < pg_snapshot_xmin(pg_current_snapshot())");`,
    replace: "",
    tests: [ep("cursor-concurrent-writers"), ep("cursor-inversion")],
    why: "a processor would pass an event of a transaction still running, and never see it (ADR-0016)"
  },
  {
    id: "poll-order-by-position",
    file: POLLER_SQL,
    find: "ORDER BY e.transaction_id ASC, e.position ASC LIMIT $${limitParamIndex}",
    replace: "ORDER BY e.position ASC LIMIT $${limitParamIndex}",
    tests: [ep("cursor-inversion")],
    why: "a batch out of cursor order: the cursor moves past events the processor has not handled"
  },
  {
    id: "pending-upper-bound-exclusive",
    file: POLLER_SQL,
    find: "clauses.push(`(e.transaction_id, e.position) <= ($${params.length + 1}::xid8, $${params.length + 2}::bigint)`);\n  params.push(upTo.transactionId",
    replace: "clauses.push(`(e.transaction_id, e.position) < ($${params.length + 1}::xid8, $${params.length + 2}::bigint)`);\n  params.push(upTo.transactionId",
    tests: [ep("pending-query-plan"), ep("sql-event-fetcher"), "packages/views/test/integration/read-check.test.ts", "packages/views/test/integration/settle-views.test.ts"],
    why: "a read that waits for its own write would not wait for the write's last event"
  },
  {
    id: "tag-key-table-wrong-key",
    file: POLLER_SQL,
    find: "`EXISTS (SELECT 1 FROM crablet_event_tag_keys t WHERE t.position = e.position AND t.key = $${paramIndex++})`",
    replace: "`EXISTS (SELECT 1 FROM crablet_event_tag_keys t WHERE t.position = e.position AND t.key <> $${paramIndex++})`",
    tests: [ep("tag-key-strategy-equivalence"), ep("sql-event-fetcher")],
    why: "a processor that requires a tag key would get events without it"
  },

  // The progress trackers.
  {
    id: "tracker-cursor-not-compared",
    file: TRACKER,
    find: "WHERE ${idCol} = $1 AND (last_transaction_id, last_position) = ($4::xid8, $5::bigint)",
    replace: "WHERE ${idCol} = $1",
    tests: [ep("postgres-progress-tracker"), ep("event-processor-integration")],
    why: "a deposed leader could move a cursor another processor already moved (ADR-0032)"
  },
  {
    id: "tracker-notify-cursor-not-compared",
    file: TRACKER,
    find: "WHERE ${idCol} = $1 AND (last_transaction_id, last_position) = ($5::xid8, $6::bigint)",
    replace: "WHERE ${idCol} = $1",
    tests: [ep("progress-notify"), "packages/views/test/integration/view-exactly-once.test.ts"],
    why: "the same, for the views' tracker, which notifies"
  },
  {
    id: "tracker-never-failed",
    file: TRACKER,
    find: "status = CASE WHEN error_count + 1 >= $3 THEN 'FAILED' ELSE status END",
    replace: "status = status",
    tests: [ep("postgres-progress-tracker")],
    why: "a processor that keeps failing would retry forever instead of stopping"
  },
  {
    id: "tracker-missing-table-is-error",
    file: TRACKER,
    find: `?.code === "42P01"`,
    replace: `?.code === "NO_SUCH_CODE"`,
    tests: [ep("postgres-progress-tracker")],
    why: "a processor started before the migrations would fail instead of waiting for its table"
  },
  {
    id: "outbox-cursor-not-compared",
    file: "packages/outbox/src/internal/OutboxProgressTracker.ts",
    find: "WHERE topic = $1 AND publisher = $2 AND (last_transaction_id, last_position) = ($6::xid8, $7::bigint)",
    replace: "WHERE topic = $1 AND publisher = $2",
    tests: ["packages/outbox/test/integration/outbox-progress-tracker.test.ts"],
    why: "a deposed outbox leader could move the cursor back and publish again (ADR-0032)"
  },

  // Leadership, against a real Postgres (eventstore/src/Leader.ts).
  {
    id: "leader-any-session-lock",
    file: "packages/eventstore/src/Leader.ts",
    find: "WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid() AND NOT pg_is_in_recovery()",
    replace: "WHERE locktype = 'advisory' AND granted AND NOT pg_is_in_recovery()",
    tests: [es("leader-liveness")],
    why: "a leader would count another session's lock as its own: two leaders"
  },
  {
    id: "leader-on-replica",
    file: "packages/eventstore/src/Leader.ts",
    find: "SELECT CASE WHEN pg_is_in_recovery() THEN false ELSE pg_try_advisory_lock($1) END AS acquired",
    replace: "SELECT pg_try_advisory_lock($1) AS acquired",
    tests: [es("leader-replica")],
    why: "a process connected to a replica would lead, and write nothing"
  },

  // The deadlines.
  {
    id: "deadline-fires-early",
    file: "packages/automations/src/internal/DeadlineStore.ts",
    find: "WHERE d.due_at <= $1::timestamptz",
    replace: "WHERE d.due_at <= $1::timestamptz + interval '100 years'",
    tests: ["packages/automations/test/integration/deadlines.test.ts"],
    why: "a deadline would fire before it is due"
  },

  // The commands' audit and verification.
  {
    id: "verify-counts-skip-first",
    file: "packages/commands/src/VerifyEvents.ts",
    find: "WHERE position >= $1::bigint AND position <= $2::bigint GROUP BY type",
    replace: "WHERE position > $1::bigint AND position <= $2::bigint GROUP BY type",
    tests: [cmd("verify-events-postgres")],
    why: "verify-events would not count the first event of its range"
  },
  {
    id: "audit-command-id-ignored",
    file: "packages/eventstore/src/CommandAuditStore.ts",
    find: "VALUES (COALESCE($1::uuid, gen_random_uuid()), pg_current_xact_id(), $2, $3::jsonb, $4::jsonb, $5::timestamptz)",
    replace: "VALUES (gen_random_uuid(), pg_current_xact_id(), $2, $3::jsonb, $4::jsonb, $5::timestamptz)",
    tests: [es("append"), cmd("command-audit")],
    why: "a command stored twice under its id would be recorded twice"
  }
];

const occurrences = (text: string, find: string): number => text.split(find).length - 1;

// The breaks whose text is not in their file exactly once: the code moved on, and the break must be rewritten.
export const stale = (list: ReadonlyArray<Break>, read: (file: string) => string): ReadonlyArray<string> =>
  list.flatMap((b) => {
    const n = occurrences(read(b.file), b.find);
    return n === 1 ? [] : [`${b.id}: its text occurs ${n} times in ${b.file}, not once`];
  });

const runTests = (files: ReadonlyArray<string>): { readonly passed: boolean; readonly seconds: number; readonly output: string } => {
  const started = Date.now();
  const r = spawnSync("node", ["--test", "--test-force-exit", "--test-concurrency=4", ...files], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { passed: r.status === 0, seconds: (Date.now() - started) / 1000, output: `${r.stdout}${r.stderr}` };
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const b of breaks) console.log(`${b.id.padEnd(36)} ${b.file}\n${"".padEnd(36)} ${b.why}`);
    process.exit(0);
  }
  const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1]?.split(",") ?? []) : null;
  const chosen = only === null ? breaks : breaks.filter((b) => only.has(b.id));
  if (only !== null && chosen.length !== only.size) {
    console.error(`unknown break ids: ${[...only].filter((id) => !breaks.some((b) => b.id === id)).join(", ")}`);
    process.exit(2);
  }
  const ids = new Set<string>();
  for (const b of breaks) {
    if (ids.has(b.id)) throw new Error(`two breaks are named ${b.id}`);
    ids.add(b.id);
  }

  const staleOnes = stale(chosen, (file) => readFileSync(file, "utf8"));
  if (staleOnes.length > 0) {
    console.error("Breaks that no longer match their file (rewrite them):\n" + staleOnes.map((s) => `  - ${s}`).join("\n"));
    process.exit(1);
  }

  const allTests = [...new Set(chosen.flatMap((b) => b.tests))].sort();
  console.log(`Control: the ${allTests.length} test files, with nothing broken...`);
  const control = runTests(allTests);
  if (!control.passed) {
    console.error(control.output.slice(-4000) + "\nThe tests fail with nothing broken; fix that first, or every break would look caught.");
    process.exit(1);
  }
  console.log(`  passed (${control.seconds.toFixed(0)} s)\n`);

  // The file being broken, so Ctrl-C puts it back.
  let current: { readonly file: string; readonly original: string } | null = null;
  const restore = (): void => {
    if (current !== null) writeFileSync(current.file, current.original);
    current = null;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { restore(); process.exit(130); });

  const survived: Array<Break> = [];
  for (const b of chosen) {
    const original = readFileSync(b.file, "utf8");
    current = { file: b.file, original };
    try {
      writeFileSync(b.file, original.replace(b.find, () => b.replace)); // a function, so `$$` in the replacement is not read as a pattern
      const r = runTests(b.tests);
      console.log(`${r.passed ? "SURVIVED" : "caught  "}  ${b.id.padEnd(36)} ${r.seconds.toFixed(0).padStart(4)} s`);
      if (r.passed) survived.push(b);
    } finally {
      restore();
    }
  }

  if (survived.length > 0) {
    console.error(`\n${survived.length} of ${chosen.length} breaks survived: the integration tests did not notice.\n` + survived.map((b) => `  - ${b.id} (${b.file}): ${b.why}`).join("\n"));
    console.error("\nWrite the test that fails on the break; do not remove the break.");
    process.exit(1);
  }
  console.log(`\nAll ${chosen.length} breaks were caught.`);
}
