# Plan: a dashboard for the poller and its consumers

**Status:** proposed (2026-10-08). Nothing built.

## Recommendation in one paragraph

Do **not** build a web dashboard application. Crablet already emits OpenTelemetry metrics and spans; the gap is that the most important number for a poller, **how far behind each consumer is**, is not a metric
at all (it is a database query behind `getLag`), and that nobody has told an operator which panels to build. So: (1) close the metric gaps, (2) ship a **Grafana dashboard as JSON, checked in and tested**
(plus alert rules), with a Docker Compose stack to try it locally, and (3) only if a need remains that Grafana cannot meet (pause, resume, reset a processor), add a small **admin endpoint** in
`packages/commands-http`-style, not a UI. The dashboard is a document in the repository, like the diagrams, not a service to run.

## Why not our own UI

- Observability is a solved product category. Grafana gives time series, alerting, retention, auth and sharing; a hand-built page would give a snapshot and a maintenance bill.
- Crablet is a library; each adopter already has (or will pick) a metrics stack. A dashboard they import fits that. A UI they must host does not.
- The one thing Grafana cannot do is act (pause a processor, reset a cursor). That is a few endpoints over the existing `ProcessorManagementService`, which can be added without a front end.

## What exists today

| Source | What it gives | Gap |
|---|---|---|
| `@crablet/metrics-otel` | counters and timers per area: poller cycles, events fetched, empty polls, backoff, leadership gauge (`crablet.poller.leadership`), view/outbox/automation success, failure, duration, events processed; command and eventstore counters; `crablet.storage.*` gauges | **no lag, no cursor position, no processor status** |
| `ProcessorManagementService` | `getStatus`, `getAllStatuses`, `getLag`, pause, resume, reset | read on demand, per processor; not exported as metrics |
| Spans (`crablet.command`, `crablet.poller.batch`, `crablet.eventstore.append`) and log annotations (`processor`, `instance`) | request and batch traces, logs filterable by processor | no trace backend wired in the examples |
| Postgres progress tables | cursor `(transaction_id, position)`, status, error count, last error, per processor | only readable by SQL |

Labels already in use: `processor`, `instance_id`, `view`.

## What the dashboard would show

Four rows, from the top of an operator's questions down.

1. **Is everything healthy? (one glance)**
   - Processors by status: running, paused, failed (stat panels, red when `failed > 0`).
   - Leader per processor: which instance holds it (`crablet.poller.leadership` = 1), and a panel that goes red when a processor has **no leader** for more than a minute.
2. **Are consumers keeping up?** *(the main panel; needs new metrics)*
   - **Lag in events** per processor: `head position − cursor position`, as a time series and a table sorted worst first.
   - **Lag in seconds** (age of the oldest unprocessed event), the number a person can reason about.
   - Throughput: events fetched and processed per second per processor; empty-poll ratio; backoff active.
3. **Is it failing?**
   - Failures per consumer (view project, outbox publish, automation decide), rate and total, with the last error text in a table (from the status row, not a metric label).
   - Outbox publish failures and retries, separate from views, because they leave the process.
4. **The write side and storage** (context, one row)
   - Appends per second, concurrency violations, command conflict retries, idempotent duplicates.
   - `crablet.storage.*`: table bytes, rows, bytes per event.

Variables: `processor`, `instance_id`, `view`. Annotations: deploys and leader changes.

## Steps

Each is its own commit.

### 1. Close the metric gaps (the real work)

New gauges, in `metrics-otel` and recorded from the shared engine in `event-poller` (as the existing poller metrics are, once for all consumers):

- `crablet.poller.lag_events` (processor): head position minus cursor position.
- `crablet.poller.lag_seconds` (processor): age of the oldest unprocessed event, or 0 when caught up.
- `crablet.poller.cursor_position` (processor), so lag can also be computed in the backend.
- `crablet.poller.status` (processor, status): 1 for the current status label, so Grafana can count running, paused, failed. Low cardinality (3 values).
- `crablet.poller.errors` counter (processor), if the failure counters per area do not already cover the engine itself.

Decision to make here: **where lag is computed.** Options: (a) the leader refreshes it each poll (cheap: it already reads the cursor and fetched batch, the head costs one `MAX(position)`), but only the leader reports and a processor with no leader reports nothing, which is exactly when you want it; (b) every instance
runs a low-frequency sampler (like `monitorStorage`), at the cost of one small query per instance per interval. Recommend **(b)**, as `monitorProcessors`, next to `monitorStorage`, default every 15 s: a dead leader must still show as growing lag.

Done when: the metrics appear in an OTLP export from the wallet example, with a test that drives a processor behind the head and asserts the gauge.

### 2. The dashboard as code

- `ops/grafana/crablet-dashboard.json`, provisioned, with the four rows above. Built against Prometheus metric names (Prometheus is the common OTel destination; the OTel names `crablet.x.y` become `crablet_x_y`). Say in the file's description that other backends need the query language swapped.
- `ops/grafana/alerts.yaml`: processor failed; no leader for 1 min; lag above N for 5 min; outbox failures rising; storage growth. Thresholds as variables with documented defaults.
- A test that keeps it honest, in the spirit of `guides-sync.test.ts`: every `crablet_*` metric a panel queries exists in `metrics-otel` (so a rename breaks CI instead of a panel), and the JSON parses and has unique panel ids.

Done when: the test passes and a dashboard imported into a clean Grafana renders against live data from step 3.

### 3. A local stack to see it

- `ops/compose.yaml` with two services: Postgres and `grafana/otel-lgtm` (one image holding the OpenTelemetry Collector, Prometheus, Tempo, Loki and Grafana). The dashboard and the alert rules are mounted into it as provisioning files. The wallet example sends OTLP to it, with a small load script (the ones the diagnostics used) so the panels move.
- No multi-container topology: we do not own anyone's production setup, and adopters bring their own Collector, Prometheus and Grafana. The guide has a short section on pointing the app at your own Collector instead.
- First thing to verify: which Effect 4 package and exporter turn `Metric`s and spans into OTLP (not yet checked), and that the image accepts mounted provisioning. If the image cannot be pinned or provisioned well enough, revisit then.
- A guide page, `docs/guides/dashboard.md`: run it, what each row means, what to do when a panel is red (links to run-in-production and monitor-it).
- The wallet example gains the OTLP exporter behind an environment variable (`OTEL_EXPORTER_OTLP_ENDPOINT`), off by default.

Done when: `docker compose up` and one command give a populated dashboard, and the guide is in the docs map.

### 4. Optional: operate, not only watch

Only if step 3 leaves people wishing to act from the dashboard. Two parts, in this order.

1. **An admin API package**, in the style of `views-http` (for example `@crablet/processors-http`): an `/admin/processors` API over `ProcessorManagementService` with list (status, lag, leader, last error), pause, resume and reset. The schema is exported, so any client can be typed against it. It needs authentication decisions the framework has so far left to the adopter (see ADR-0014 on what the HTTP layer assumes), so it ships as handlers the adopter mounts behind their own auth, never on by default. Processor ids are free-form, so the API carries an optional description to say what each processor is for. Grafana can link to it.
2. **A generic Foldkit page**, an example in `examples/` (not a package, not coupled to the course or wallet example). It takes a base URL and is typed against the admin API's schema only: a table of processors, pause and resume, and reset behind a confirmation. It states that reset is destructive and that the API must be behind auth. Do it after the Foldkit upgrade from rc.118 is settled, so it is not built on a version we are leaving.

Cost to note: once adopters type a client against the admin schema, changing it breaks them. This is the same evolution question `api-follow-ups.md` deferred (item B); decide the rules before publishing the package.

Done when: the handlers have integration tests (including that reset needs the processor paused or says what it does otherwise), and the page runs against the wallet and the course example without a line of either in it.

### 5. Keep it honest

- CONTRIBUTING: adding a metric means adding it to the dashboard test's expectations or saying why it has no panel.
- Update `docs/reference.md#operating-it` and the `metrics-otel` README with the new metrics.

## Risks and costs

- **Lag in seconds needs the event's timestamp**, which means reading the oldest unprocessed event each sample; a small indexed read, but measure it on a large table.
- **Cardinality.** Labels are processor and instance only (tens of series). Never label by command, stream or tag value.
- **A sampler is another thing that can fail.** It must never take the application down: errors are logged and the gauge goes stale, which the alert on "metric absent" catches.
- **Prometheus-shaped.** Adopters on Datadog, New Relic or Honeycomb get the metrics and spans from OTel but import none of the JSON. Say so; the metric catalogue is the portable part.
- **Dashboards rot.** The sync test in step 2 is the defence; without it this plan would not be worth doing.

## How we will know

- A stopped leader shows as growing lag and a "no leader" alert within a minute, in the local stack.
- A deliberately failing view shows on the failed counter, the status panel and the last-error table.
- Renaming a metric in `metrics-otel` fails CI.

## Decisions for the owner

1. ~~Reference stack~~ Decided 2026-10-08: Grafana with Prometheus over OTLP, locally the single `grafana/otel-lgtm` image.
2. Lag sampled by every instance (recommended) or by the leader only?
3. Is the admin API (step 4) in scope, or only watching?
4. Where does `ops/` live: in this repository (recommended, so the test can check it), or a separate one?
