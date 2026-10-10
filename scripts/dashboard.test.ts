// Keeps the Grafana dashboard and the alert rules in step with @crablet/metrics-otel (docs/plans/dashboard.md, step 2). A renamed or removed metric must break
// this test, not a panel on a screen nobody is looking at.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { dashboard, dashboardPath, FRESH_SECONDS, MODULE_LOCKS, render } from "./build-dashboard.ts";
import { AUTOMATIONS_LOCK_KEY, OUTBOX_LOCK_KEY, VIEWS_LOCK_KEY } from "../packages/eventstore/src/Leader.ts";
import * as CommandMetrics from "../packages/metrics-otel/src/CommandMetrics.ts";
import * as PeriodMetrics from "../packages/metrics-otel/src/PeriodMetrics.ts";
import * as EventStoreMetrics from "../packages/metrics-otel/src/EventStoreMetrics.ts";
import * as LeaderMetrics from "../packages/metrics-otel/src/LeaderMetrics.ts";
import * as PollerMetrics from "../packages/metrics-otel/src/PollerMetrics.ts";
import * as ReadConsistencyMetrics from "../packages/metrics-otel/src/ReadConsistencyMetrics.ts";
import * as StorageMetrics from "../packages/metrics-otel/src/StorageMetrics.ts";
import * as ViewMetrics from "../packages/metrics-otel/src/ViewMetrics.ts";
import * as OutboxMetrics from "../packages/metrics-otel/src/OutboxMetrics.ts";
import * as AutomationMetrics from "../packages/metrics-otel/src/AutomationMetrics.ts";

const alertsPath = resolve(import.meta.dir, "../ops/grafana/alerts.yaml");

interface Described { readonly id: string; readonly type: string }
const isMetric = (v: unknown): v is Described => typeof v === "object" && v !== null && "id" in v && "type" in v && typeof (v as Described).id === "string";

// Every metric the package exports, with the name or names Prometheus gives it when it arrives by OTLP. Measured against the grafana/otel-lgtm image
// (docs/plans/dashboard.md, step 2): a counter keeps its name, a gauge gains `_ratio`, a histogram (a timer) becomes `_milliseconds_bucket|count|sum`.
const prometheusNames = (): Map<string, ReadonlyArray<string>> => {
  const out = new Map<string, ReadonlyArray<string>>();
  const modules = [CommandMetrics, PeriodMetrics, EventStoreMetrics, LeaderMetrics, PollerMetrics, ReadConsistencyMetrics, StorageMetrics, ViewMetrics, OutboxMetrics, AutomationMetrics];
  for (const mod of modules) {
    for (const [key, value] of Object.entries(mod)) {
      if (key === "observe") continue;
      const metrics: ReadonlyArray<unknown> = isMetric(value) ? [value] : typeof value === "object" && value !== null ? Object.values(value) : [];
      for (const m of metrics) {
        if (!isMetric(m)) continue;
        const base = m.id.replaceAll(".", "_");
        const names = m.type === "Gauge" ? [`${base}_ratio`] : m.type === "Histogram" ? ["bucket", "count", "sum"].map((s) => `${base}_milliseconds_${s}`) : m.type === "Counter" ? [base] : [];
        if (names.length === 0) throw new Error(`metric ${m.id} has a type (${m.type}) this test does not know the Prometheus name of`);
        out.set(m.id, names);
      }
    }
  }
  return out;
};

const collect = (value: unknown, found: Array<string>): void => {
  if (typeof value === "string") for (const m of value.matchAll(/\bcrablet_[a-z0-9_]+/g)) found.push(m[0]);
  else if (Array.isArray(value)) for (const v of value) collect(v, found);
  else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) collect(v, found);
};

const alerts = async (): Promise<{ groups: Array<{ name: string; rules: Array<Record<string, any>> }> }> => Bun.YAML.parse(await Bun.file(alertsPath).text()) as any;

// A metric with no panel and no alert must say why. Adding a metric to metrics-otel without a panel or a line here fails the test below.
const NO_PANEL: Record<string, string> = {
  "crablet.poller.backoff_empty_poll_count": "an internal counter of the backoff; the `Backed off` panel shows the state that matters",
  "crablet.period.clock_behind": "a rare signal about clocks that disagree, read in an ad hoc query or alerted on by an application that has periods; most applications have none, and the library's dashboard stays free of it",
  "crablet.eventstore.event_type_appended": "per event type, which is an unbounded label; the appends panel shows the total, and the type breakdown belongs in an ad hoc query"
};

// The labels each metric carries, from where it is recorded (the tags at each `Metric.withAttributes` / `observe` call). A panel or an alert that groups or filters by a label
// its metric does not carry gets one merged series and still "has data", which is how `by (processor)` on the leadership gauge went unnoticed until a crash test: the gauge is
// per MODULE lock, tagged `lock_key`. Every metric must be listed, so adding one means saying what its labels are.
const LABELS: Record<string, ReadonlyArray<string>> = {
  "crablet.poller.leadership": ["lock_key", "instance_id"],
  "crablet.poller.processing_cycles": ["processor", "instance_id"],
  "crablet.poller.events_fetched": ["processor", "instance_id"],
  "crablet.poller.empty_polls": ["processor", "instance_id"],
  "crablet.poller.backoff_active": ["processor", "instance_id"],
  "crablet.poller.backoff_empty_poll_count": ["processor", "instance_id"],
  "crablet.poller.lag_events": ["processor", "instance_id"],
  "crablet.poller.lag_seconds": ["processor", "instance_id"],
  "crablet.poller.cursor_position": ["processor", "instance_id"],
  "crablet.poller.status": ["processor", "instance_id", "status"],
  "crablet.view.project.duration": ["view"], "crablet.view.project.successes": ["view"], "crablet.view.project.failures": ["view"], "crablet.view.events_projected": ["view"],
  "crablet.automation.decide.duration": ["automation"], "crablet.automation.decide.successes": ["automation"], "crablet.automation.decide.failures": ["automation"], "crablet.automation.events_processed": ["automation"],
  "crablet.outbox.publish.duration": ["publisher"], "crablet.outbox.publish.successes": ["publisher"], "crablet.outbox.publish.failures": ["publisher"], "crablet.outbox.events_published": ["publisher"],
  "crablet.command.handle.duration": ["command_type"], "crablet.command.handle.successes": ["command_type"], "crablet.command.handle.failures": ["command_type"],
  "crablet.command.idempotent_duplicates": ["command_type"], "crablet.command.conflict_retries": ["command_type"],
  "crablet.period.clock_behind": [],
  "crablet.eventstore.append.duration": [], "crablet.eventstore.append.successes": [], "crablet.eventstore.append.failures": [],
  "crablet.eventstore.events_appended": [], "crablet.eventstore.event_type_appended": ["event_type"], "crablet.eventstore.concurrency_violations": [], "crablet.eventstore.decoding_failures": ["event_type"],
  "crablet.eventstore.wakeups_recorded": [], "crablet.eventstore.wakeups_sent": [], "crablet.eventstore.wakeups_saved": [],
  "crablet.read.consistency.reads": ["mode", "outcome"], "crablet.read.consistency.wait.duration": ["mode"],
  "crablet.storage.table_bytes": ["table", "part"], "crablet.storage.table_rows": ["table"], "crablet.storage.bytes_per_event": []
};
// Labels a query may use besides its metrics': `le` (a histogram's bucket), `module` (made from `lock_key` by label_replace), `job` and `service_name` (from the exporter's resource).
const DERIVED = ["le", "module", "job", "service_name"];

const labelsUsed = (expr: string): ReadonlyArray<string> => {
  const used: Array<string> = [];
  for (const m of expr.matchAll(/\b(?:by|without|on|ignoring)\s*\(([^)]*)\)/g)) used.push(...m[1]!.split(",").map((l) => l.trim()).filter((l) => l !== ""));
  for (const m of expr.matchAll(/\{([^}]*)\}/g)) for (const l of m[1]!.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:=~|!=|!~|=)/g)) used.push(l[1]!);
  for (const m of expr.matchAll(/label_values\(\s*[a-z_]+\s*,\s*([a-z_]+)\s*\)/g)) used.push(m[1]!);
  return used;
};

const exprsOf = (value: unknown, found: Array<string> = []): Array<string> => {
  if (Array.isArray(value)) value.forEach((v) => exprsOf(v, found));
  else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if ((k === "expr" || k === "query") && typeof v === "string") found.push(v);
      else exprsOf(v, found);
    }
  }
  return found;
};

const allowedLabels = (expr: string): Set<string> => {
  const byPrometheusName = new Map<string, string>();
  for (const [id, names] of prometheusNames()) for (const n of names) byPrometheusName.set(n, id);
  const allowed = new Set(DERIVED);
  for (const name of expr.matchAll(/\bcrablet_[a-z0-9_]+/g)) for (const l of LABELS[byPrometheusName.get(name[0])!] ?? []) allowed.add(l);
  return allowed;
};

describe("the labels the queries use", () => {
  test("every metric has its labels declared, and nothing declared is not a metric", () => {
    const ids = [...prometheusNames().keys()].sort();
    expect(Object.keys(LABELS).sort()).toEqual(ids);
  });

  test("a panel, a variable, an annotation or an alert groups and filters only by labels that its metrics carry", async () => {
    const queries = [...exprsOf(dashboard()), ...exprsOf(await alerts())];
    expect(queries.length).toBeGreaterThan(40);
    const wrong: Array<string> = [];
    for (const q of queries) {
      const allowed = allowedLabels(q);
      for (const label of labelsUsed(q)) if (!allowed.has(label)) wrong.push(`${label} in: ${q.slice(0, 120)}`);
    }
    expect(wrong).toEqual([]);
  });

  test("the checker itself: grouping the leadership gauge by processor is caught, by lock_key is not", () => {
    expect([...labelsUsed("sum by (processor) (crablet_poller_leadership_ratio)")].filter((l) => !allowedLabels("sum by (processor) (crablet_poller_leadership_ratio)").has(l))).toEqual(["processor"]);
    expect([...labelsUsed("sum by (lock_key) (crablet_poller_leadership_ratio)")].filter((l) => !allowedLabels("sum by (lock_key) (crablet_poller_leadership_ratio)").has(l))).toEqual([]);
  });
});

describe("leadership is per module", () => {
  test("the module names in the dashboard are the lock keys in the code", () => {
    expect(MODULE_LOCKS).toEqual({ outbox: OUTBOX_LOCK_KEY, views: VIEWS_LOCK_KEY, automations: AUTOMATIONS_LOCK_KEY });
  });

  test("the alert names the same keys, and the same freshness window, as the dashboard", async () => {
    const text = await Bun.file(alertsPath).text();
    const pairs = [...text.matchAll(/"module", "([a-z]+)", "lock_key", "(\d+)"/g)].map((m) => [m[1]!, BigInt(m[2]!)] as const);
    expect(Object.fromEntries(pairs)).toEqual({ outbox: OUTBOX_LOCK_KEY, views: VIEWS_LOCK_KEY, automations: AUTOMATIONS_LOCK_KEY });
    expect([...text.matchAll(/timestamp\(crablet_poller_leadership_ratio\) < (\d+)/g)].map((m) => Number(m[1]))).toEqual([FRESH_SECONDS]);
  });
});

describe("the dashboard", () => {
  test("the committed file is what the generator produces", async () => {
    expect(await Bun.file(dashboardPath).text()).toBe(render());
  });

  test("panels have unique ids, titles and a query; none runs off the grid or overlaps another", () => {
    const panels = dashboard().panels as Array<Record<string, any>>;
    const ids = panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const content = panels.filter((p) => p.type !== "row");
    expect(new Set(content.map((p) => p.title)).size).toBe(content.length);
    for (const p of content) {
      expect(p.targets.length, p.title).toBeGreaterThan(0);
      for (const t of p.targets) expect(String(t.expr).length, p.title).toBeGreaterThan(0);
      expect(p.gridPos.x + p.gridPos.w, p.title).toBeLessThanOrEqual(24);
    }
    const cells = new Set<string>();
    for (const p of panels) {
      for (let cx = p.gridPos.x; cx < p.gridPos.x + p.gridPos.w; cx++) {
        for (let cy = p.gridPos.y; cy < p.gridPos.y + p.gridPos.h; cy++) {
          expect(cells.has(`${cx},${cy}`), `${p.title} overlaps another panel at ${cx},${cy}`).toBe(false);
          cells.add(`${cx},${cy}`);
        }
      }
    }
  });

  test("every metric a panel, a variable or an annotation queries exists in metrics-otel, under the Prometheus name it arrives with", () => {
    const known = new Set([...prometheusNames().values()].flat());
    const used: Array<string> = [];
    collect(dashboard(), used);
    expect(used.length).toBeGreaterThan(20);
    expect([...new Set(used)].filter((n) => !known.has(n))).toEqual([]);
  });

  test("every metric in metrics-otel has a panel or an alert, or a stated reason for having none", async () => {
    const used: Array<string> = [];
    collect(dashboard(), used);
    collect(await alerts(), used);
    const usedSet = new Set(used);
    const unaccounted = [...prometheusNames()].filter(([id, names]) => !names.some((n) => usedSet.has(n)) && !(id in NO_PANEL)).map(([id]) => id);
    expect(unaccounted).toEqual([]);
    for (const id of Object.keys(NO_PANEL)) expect(prometheusNames().has(id), `NO_PANEL names ${id}, which is not a metric`).toBe(true);
    for (const [id, names] of prometheusNames()) {
      if (id in NO_PANEL) expect(names.some((n) => usedSet.has(n)), `${id} is listed as having no panel but has one`).toBe(false);
    }
  });
});

describe("the alert rules", () => {
  test("rules have unique uids and titles, a condition that names a query in the rule, and only metrics that exist", async () => {
    const parsed = await alerts();
    const rules = parsed.groups.flatMap((g) => g.rules);
    expect(rules.length).toBeGreaterThan(3);
    expect(new Set(rules.map((r) => r.uid)).size).toBe(rules.length);
    expect(new Set(rules.map((r) => r.title)).size).toBe(rules.length);
    for (const r of rules) {
      expect(r.data.map((d: any) => d.refId), r.title).toContain(r.condition);
      expect(["Alerting", "OK", "NoData"], r.title).toContain(r.noDataState);
      expect(r.annotations?.summary, r.title).toBeTruthy();
    }
    const known = new Set([...prometheusNames().values()].flat());
    const used: Array<string> = [];
    collect(parsed, used);
    expect(used.length).toBeGreaterThan(5);
    expect([...new Set(used)].filter((n) => !known.has(n))).toEqual([]);
  });
});
