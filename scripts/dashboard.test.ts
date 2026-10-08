// Keeps the Grafana dashboard and the alert rules in step with @crablet/metrics-otel (docs/plans/dashboard.md, step 2). A renamed or removed metric must break
// this test, not a panel on a screen nobody is looking at.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { dashboard, dashboardPath, render } from "./build-dashboard.ts";
import * as CommandMetrics from "../packages/metrics-otel/src/CommandMetrics.ts";
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
  const modules = [CommandMetrics, EventStoreMetrics, LeaderMetrics, PollerMetrics, ReadConsistencyMetrics, StorageMetrics, ViewMetrics, OutboxMetrics, AutomationMetrics];
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
  "crablet.eventstore.event_type_appended": "per event type, which is an unbounded label; the appends panel shows the total, and the type breakdown belongs in an ad hoc query"
};

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
