// Builds ops/grafana/crablet-dashboard.json, the Grafana dashboard for a Crablet application, from the definition below.
//   bun scripts/build-dashboard.ts           writes the file
//   bun scripts/build-dashboard.ts --check   fails if the committed file differs (the unit tests do the same)
//
// The queries are PromQL over the names Prometheus gives the metrics when they arrive by OTLP (the Grafana otel-lgtm image, or a Collector with a
// Prometheus backend): a counter keeps its name, a gauge gains `_ratio`, a timer becomes `<name>_milliseconds_bucket|count|sum`
// (docs/plans/dashboard.md, step 2). scripts/dashboard.test.ts derives those names from @crablet/metrics-otel and fails when a panel or an alert
// queries one that does not exist, or when a metric has neither a panel nor a stated reason for having none.
import { resolve } from "node:path";

type Target = { readonly expr: string; readonly legend?: string; readonly instant?: boolean };
type Panel = Record<string, unknown>;

const DS = { type: "prometheus", uid: "${ds}" };
const P = 'processor=~"$processor"';
const V = 'view=~"$view"';

let nextId = 1;
let y = 0;
let x = 0;

const place = (w: number, h: number) => {
  if (x + w > 24) { x = 0; y += h; }
  const pos = { x, y, w, h };
  x += w;
  return pos;
};
const endLine = () => { if (x !== 0) { x = 0; y += 8; } };

const targets = (ts: ReadonlyArray<Target>) =>
  ts.map((t, i) => ({ refId: String.fromCharCode(65 + i), datasource: DS, expr: t.expr, legendFormat: t.legend ?? "{{processor}}", instant: t.instant === true, range: t.instant !== true }));

const row = (title: string): Panel => { endLine(); const p = { id: nextId++, type: "row", title, collapsed: false, gridPos: { x: 0, y, w: 24, h: 1 }, panels: [] }; y += 1; return p; };

const series = (title: string, description: string, unit: string, ts: ReadonlyArray<Target>, w = 12): Panel => ({
  id: nextId++, type: "timeseries", title, description, datasource: DS, gridPos: place(w, 8), targets: targets(ts),
  fieldConfig: { defaults: { unit, custom: { lineWidth: 1, fillOpacity: 8 } }, overrides: [] },
  options: { legend: { displayMode: "list", placement: "bottom" }, tooltip: { mode: "multi", sort: "desc" } }
});

const stat = (title: string, description: string, expr: string, redAbove?: number): Panel => ({
  id: nextId++, type: "stat", title, description, datasource: DS, gridPos: place(6, 4), targets: targets([{ expr, legend: "", instant: true }]),
  fieldConfig: { defaults: { unit: "short", thresholds: { mode: "absolute", steps: redAbove === undefined ? [{ color: "green", value: null }] : [{ color: "green", value: null }, { color: "red", value: redAbove }] } }, overrides: [] },
  options: { reduceOptions: { calcs: ["lastNotNull"] }, colorMode: redAbove === undefined ? "none" : "background" }
});

const table = (title: string, description: string, ts: ReadonlyArray<Target>, w = 12): Panel => ({
  id: nextId++, type: "table", title, description, datasource: DS, gridPos: place(w, 8),
  targets: targets(ts.map((t) => ({ ...t, instant: true }))),
  transformations: [{ id: "merge", options: {} }],
  fieldConfig: { defaults: {}, overrides: [] }, options: { showHeader: true, sortBy: [{ displayName: "Value", desc: true }] }
});

const rate = (m: string, sel = "") => `rate(${m}${sel}[$__rate_interval])`;

const panels = (): ReadonlyArray<Panel> => {
  nextId = 1; y = 0; x = 0;
  const out: Array<Panel> = [];
  out.push(row("Is everything healthy?"));
  out.push(stat("Failed processors", "Processors whose status is FAILED: they stopped after too many errors and need a person (see Run it in production). Reported by every instance; counted once per processor.",
    `count(max by (processor) (crablet_poller_status_ratio{status="FAILED",${P}} == 1)) or vector(0)`, 1));
  out.push(stat("Paused processors", "Processors an operator paused.", `count(max by (processor) (crablet_poller_status_ratio{status="PAUSED",${P}} == 1)) or vector(0)`));
  out.push(stat("Processors without a leader", "Processors no instance currently leads, so nothing is processing them. A leader that crashed never reports 0: its series stops, so the count rises once it goes stale (about five minutes in Prometheus).",
    `count(max by (processor) (crablet_poller_status_ratio{status="ACTIVE",${P}})) - count(sum by (processor) (crablet_poller_leadership_ratio{${P}}) >= 1) or vector(0)`, 1));
  out.push(stat("Processors reporting", "Processors known to the instances that are reporting. Zero means nothing is reporting at all.", `count(max by (processor) (crablet_poller_status_ratio{${P}}))`));
  out.push(table("Leader of each processor", "The instance that last reported leadership (1) of each processor.",
    [{ expr: `max by (processor, instance_id) (crablet_poller_leadership_ratio{${P}}) == 1`, legend: "" }]));
  out.push(table("Status of each processor", "Current status. Every instance reports the same value.",
    [{ expr: `max by (processor, status) (crablet_poller_status_ratio{${P}}) == 1`, legend: "" }]));

  out.push(row("Are the consumers keeping up?"));
  out.push(series("Lag in events", "Events the processor selects that are committed and after its cursor, counted up to 100 000. Counted against the processor's own selection, not the end of the log. Every instance reports it, so the query takes the max.",
    "short", [{ expr: `max by (processor) (crablet_poller_lag_events_ratio{${P}})` }]));
  out.push(series("Lag in seconds", "Age, by the events' own occurred_at, of the first event waiting for the processor; 0 when it is caught up. Rising while the processor is ACTIVE means it is stuck or slow.",
    "s", [{ expr: `max by (processor) (crablet_poller_lag_seconds_ratio{${P}})` }]));
  out.push(table("Worst first", "Lag now, per processor.", [
    { expr: `max by (processor) (crablet_poller_lag_seconds_ratio{${P}})`, legend: "seconds" },
    { expr: `max by (processor) (crablet_poller_lag_events_ratio{${P}})`, legend: "events" }
  ]));
  out.push(series("Events fetched per second", "Events the processor's loop fetched (the leader's work).", "ops", [{ expr: `sum by (processor) (${rate("crablet_poller_events_fetched", `{${P}}`)})` }]));
  out.push(series("Idle polls", "The share of polls that found nothing. High and steady is normal for a quiet system.", "percentunit",
    [{ expr: `sum by (processor) (${rate("crablet_poller_empty_polls", `{${P}}`)}) / sum by (processor) (${rate("crablet_poller_processing_cycles", `{${P}}`)})` }]));
  out.push(series("Backed off", "1 while the processor has backed off after errors or empty polls.", "short", [{ expr: `max by (processor) (crablet_poller_backoff_active_ratio{${P}})` }]));
  out.push(series("Cursor position", "Where each processor has read up to.", "short", [{ expr: `max by (processor) (crablet_poller_cursor_position_ratio{${P}})` }]));

  out.push(row("Is it failing?"));
  out.push(series("View projection failures", "Failures per second by view.", "ops", [{ expr: `sum by (view) (${rate("crablet_view_project_failures", `{${V}}`)})`, legend: "{{view}}" }]));
  out.push(series("Automation and outbox failures", "Failures per second: automations decide, outbox publishers publish (to something outside the process).", "ops", [
    { expr: `sum by (automation) (${rate("crablet_automation_decide_failures")})`, legend: "automation {{automation}}" },
    { expr: `sum by (publisher) (${rate("crablet_outbox_publish_failures")})`, legend: "publisher {{publisher}}" }
  ]));
  out.push(series("View projection time (p95)", "95th percentile of one projection call, by view.", "ms",
    [{ expr: `histogram_quantile(0.95, sum by (le, view) (${rate("crablet_view_project_duration_milliseconds_bucket", `{${V}}`)}))`, legend: "{{view}}" }]));
  out.push(series("Successful calls per second", "Projections, automation decisions and outbox publishes that succeeded, to read the failure panels against.", "ops", [
    { expr: `sum by (view) (${rate("crablet_view_project_successes", `{${V}}`)})`, legend: "view {{view}}" },
    { expr: `sum by (automation) (${rate("crablet_automation_decide_successes")})`, legend: "automation {{automation}}" },
    { expr: `sum by (publisher) (${rate("crablet_outbox_publish_successes")})`, legend: "publisher {{publisher}}" }
  ]));
  out.push(series("Automation decision time (p95)", "95th percentile of one automation decision, by automation.", "ms",
    [{ expr: `histogram_quantile(0.95, sum by (le, automation) (${rate("crablet_automation_decide_duration_milliseconds_bucket")}))`, legend: "{{automation}}" }]));
  out.push(series("Outbox publish time (p95)", "95th percentile of one publish call, by publisher.", "ms",
    [{ expr: `histogram_quantile(0.95, sum by (le, publisher) (${rate("crablet_outbox_publish_duration_milliseconds_bucket")}))`, legend: "{{publisher}}" }]));
  out.push(series("Events handled per second", "Events projected by views, handled by automations and published by the outbox.", "ops", [
    { expr: `sum by (view) (${rate("crablet_view_events_projected", `{${V}}`)})`, legend: "view {{view}}" },
    { expr: `sum by (automation) (${rate("crablet_automation_events_processed")})`, legend: "automation {{automation}}" },
    { expr: `sum by (publisher) (${rate("crablet_outbox_events_published")})`, legend: "publisher {{publisher}}" }
  ]));
  out.push(series("Stored events that could not be read", "A stored event the current definitions cannot decode: an unsafe event change (Evolving events). Should stay at zero.", "ops",
    [{ expr: `sum by (event_type) (${rate("crablet_eventstore_decoding_failures")})`, legend: "{{event_type}}" }]));

  out.push(row("The write side"));
  out.push(series("Appends per second", "Events appended, and append calls that failed.", "ops", [
    { expr: `sum(${rate("crablet_eventstore_events_appended")})`, legend: "events appended" },
    { expr: `sum(${rate("crablet_eventstore_append_successes")})`, legend: "append calls that succeeded" },
    { expr: `sum(${rate("crablet_eventstore_append_failures")})`, legend: "append calls that failed" }
  ]));
  out.push(series("Contention", "Commands that retried after a conflict, appends the DCB condition refused, and commands recognised as repeats.", "ops", [
    { expr: `sum(${rate("crablet_command_conflict_retries")})`, legend: "conflict retries" },
    { expr: `sum(${rate("crablet_eventstore_concurrency_violations")})`, legend: "concurrency violations" },
    { expr: `sum(${rate("crablet_command_idempotent_duplicates")})`, legend: "idempotent duplicates" }
  ]));
  out.push(series("Command time (p95)", "95th percentile of handling one command, by command type, retries included.", "ms",
    [{ expr: `histogram_quantile(0.95, sum by (le, command_type) (${rate("crablet_command_handle_duration_milliseconds_bucket")}))`, legend: "{{command_type}}" }]));
  out.push(series("Commands per second", "Commands that succeeded, and commands that failed (rejected by their rules or by an error) by command type.", "ops", [
    { expr: `sum(${rate("crablet_command_handle_successes")})`, legend: "succeeded" },
    { expr: `sum by (command_type) (${rate("crablet_command_handle_failures")})`, legend: "failed {{command_type}}" }
  ]));
  out.push(series("Append time (p95)", "95th percentile of the conditional append.", "ms",
    [{ expr: `histogram_quantile(0.95, sum by (le) (${rate("crablet_eventstore_append_duration_milliseconds_bucket")}))`, legend: "append" }]));
  out.push(series("Reads that waited for views", "Reads that carried a consistency marker, per second by mode, and how long the waiting ones waited (p95).", "ops", [
    { expr: `sum by (mode) (${rate("crablet_read_consistency_reads")})`, legend: "reads {{mode}}" }
  ]));
  out.push(series("Time reads waited (p95)", "How long reads spent waiting for views to catch up (only reads that waited).", "ms",
    [{ expr: `histogram_quantile(0.95, sum by (le, mode) (${rate("crablet_read_consistency_wait_duration_milliseconds_bucket")}))`, legend: "{{mode}}" }]));

  out.push(row("Storage"));
  out.push(series("Table size", "Total bytes (heap, indexes and TOAST) of each library table. Nothing deletes events, so watch the growth.", "bytes",
    [{ expr: `max by (table) (crablet_storage_table_bytes_ratio{part="total"})`, legend: "{{table}}" }]));
  out.push(series("Rows", "The planner's estimate, as fresh as the last autovacuum or ANALYZE.", "short",
    [{ expr: `max by (table) (crablet_storage_table_rows_ratio)`, legend: "{{table}}" }]));
  out.push(series("Bytes per event", "The events table and the tag table with their indexes, divided by events (about 1.2 KB at the time of writing).", "bytes",
    [{ expr: `max(crablet_storage_bytes_per_event_ratio)`, legend: "per event" }]));
  endLine();
  return out;
};

export const dashboard = (): Record<string, unknown> => ({
  uid: "crablet-overview",
  title: "Crablet",
  description: "The poller and its consumers, the write side and storage of a Crablet application. Queries are PromQL over the Prometheus names of the OTLP metrics; for another backend, swap the queries. Generated by scripts/build-dashboard.ts: edit that, not this file.",
  tags: ["crablet"],
  schemaVersion: 39,
  version: 1,
  editable: true,
  refresh: "30s",
  time: { from: "now-1h", to: "now" },
  timezone: "browser",
  templating: {
    list: [
      { name: "ds", label: "Data source", type: "datasource", query: "prometheus", current: {}, hide: 0 },
      { name: "processor", label: "Processor", type: "query", datasource: DS, query: { query: "label_values(crablet_poller_status_ratio, processor)", refId: "p" }, refresh: 2, includeAll: true, allValue: ".*", multi: true, current: {} },
      { name: "view", label: "View", type: "query", datasource: DS, query: { query: "label_values(crablet_view_project_successes, view)", refId: "v" }, refresh: 2, includeAll: true, allValue: ".*", multi: true, current: {} }
    ]
  },
  annotations: {
    list: [{
      name: "Leader changes", enable: true, iconColor: "orange", datasource: DS,
      expr: "changes(max by (processor) (crablet_poller_leadership_ratio == 1)[1m:]) > 0", titleFormat: "leader change", textFormat: "{{processor}}", step: "60s"
    }]
  },
  panels: panels()
});

export const dashboardPath = resolve(import.meta.dir, "../ops/grafana/crablet-dashboard.json");
export const render = (): string => `${JSON.stringify(dashboard(), null, 2)}\n`;

if (import.meta.main) {
  const file = Bun.file(dashboardPath);
  if (process.argv.includes("--check")) {
    if ((await file.exists()) && (await file.text()) === render()) console.log("dashboard is up to date");
    else { console.error("ops/grafana/crablet-dashboard.json is out of date: run `bun scripts/build-dashboard.ts`"); process.exit(1); }
  } else {
    await Bun.write(dashboardPath, render());
    console.log(`wrote ${dashboardPath}`);
  }
}
