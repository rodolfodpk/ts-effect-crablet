# Plan: a dashboard for the poller and its consumers

**Status:** steps 1 to 4 done (2026-10-08); step 5 (keeping it honest in CONTRIBUTING) not done.

## Recommendation in one paragraph

Do **not** build a web dashboard application. Crablet already emits OpenTelemetry metrics and spans; the gap is that the most important number for a poller, **how far behind each consumer is**, is not a metric
at all (it is a database query behind `getLag`, and `getLag` is the wrong number: see step 1), and that nobody has told an operator which panels to build. So: (1) close the metric gaps, (2) ship a **Grafana dashboard as JSON, checked in and tested**
(plus alert rules), with a one-image Docker Compose stack to try it locally, and (3) only if a need remains that Grafana cannot meet (pause, resume or reset a processor), add a small **admin API package**, and on top of it, optionally, a generic Foldkit example (step 4). The dashboard is a document in the repository, like the diagrams, not a service to run.

## Why not our own UI

- Observability is a solved product category. Grafana gives time series, alerting, retention, auth and sharing; a hand-built page would give a snapshot and a maintenance bill.
- Crablet is a library; each adopter already has (or will pick) a metrics stack. A dashboard they import fits that. A UI they must host does not.
- The one thing Grafana cannot do is act (pause, resume or reset a processor). That is a few endpoints over the existing `ProcessorManagementService`; a front end on top is optional and comes last (step 4).

## What exists today

| Source | What it gives | Gap |
|---|---|---|
| `@crablet/metrics-otel` | counters and timers per area: poller cycles, events fetched, empty polls, backoff, leadership gauge (`crablet.poller.leadership`), view/outbox/automation success, failure, duration, events processed; command and eventstore counters; `crablet.storage.*` gauges | **no lag, no cursor position, no processor status** |
| `ProcessorManagementService` | `getStatus`, `getAllStatuses`, `getLag`, backoff info, pause, resume, reset | read on demand, per processor; not exported as metrics. `getLag` is `MAX(position) − last_position` over the whole log: wrong for a consumer of a rare event type, whose cursor only lands on events it selected (see step 1) |
| Spans (`crablet.command`, `crablet.poller.batch`, `crablet.eventstore.append`) and log annotations (`processor`, `instance`) | request and batch traces, logs filterable by processor | no trace backend wired in the examples |
| Postgres progress tables (separate ones for views, automations and outbox, keyed by view, automation, or topic plus publisher) | cursor, status (`ACTIVE`, `PAUSED`, `FAILED`), error count, last error; outbox rows also hold leader instance and heartbeat | only readable by SQL; the three kinds differ in shape |

Labels already in use: `processor` and `instance_id` on the poller metrics, `view` on view metrics, `publisher` on outbox metrics. The same consumer therefore has a different label in different metrics; the sampler's gauges and the dashboard's variables must map between them (a view's `processor` id versus its `view` name), which step 1 has to settle.

`crablet.poller.leadership` is set to 1 on acquiring and 0 on losing leadership. A process that crashes never sets 0; its series simply stops being exported. So "no leader" cannot be read as "leadership == 0": the alert is "no series at 1 for this processor" (absent or sum equal to 0).

## What the dashboard would show

Four rows, from the top of an operator's questions down.

1. **Is everything healthy? (one glance)**
   - Processors by status: `ACTIVE`, `PAUSED`, `FAILED` (stat panels, red when `FAILED > 0`).
   - Leader per processor: which instance holds it (`crablet.poller.leadership` = 1), and a panel that goes red when a processor has **no leader** for more than a minute.
2. **Are consumers keeping up?** *(the main panel; needs new metrics)*
   - **Lag in events** per processor: the events it selects that are waiting after its cursor, as a time series and a table sorted worst first.
   - **Lag in seconds** (age of the first event waiting for it), the number a person can reason about.
   - Throughput: events fetched per second per processor, and events projected, published or processed per consumer (the metrics for those use `view`, `publisher` or no processor label, see above); empty-poll ratio; backoff active.
3. **Is it failing?**
   - Failures per consumer (view project, outbox publish, automation decide), rate and total, with the last error text in a table (from the status row, not a metric label).
   - Outbox publish failures and duration, separate from views, because they leave the process. (There is no retry metric today; adding one is optional in step 1.)
4. **The write side and storage** (context, one row)
   - Appends per second, concurrency violations, command conflict retries, idempotent duplicates.
   - `crablet.storage.*`: table bytes, rows, bytes per event.

Variables: `processor`, `instance_id`, `view`. Annotations: leader changes (from the leadership gauge); deploys only if the adopter's pipeline provides them.

## Steps

Each is its own commit.

### 1. Close the metric gaps (the real work) - done (2026-10-08)

Built as `monitorProcessors` in `@crablet/event-poller/MonitorProcessors`, one sampler per process over the management services of the modules it runs (`[views, automations, outbox]`), default every 15 s, in every instance. Gauges in `PollerMetrics`, all tagged `processor` and `instance_id`:

- `crablet.poller.lag_events`: events the processor selects that are committed and after its cursor, counted up to `BACKLOG_CAP` (100 000).
- `crablet.poller.lag_seconds`: age, by the events' own `occurred_at`, of the first of them; 0 when caught up.
- `crablet.poller.cursor_position`.
- `crablet.poller.status` (also `status`): 1 for the current `ACTIVE`, `PAUSED` or `FAILED`, 0 for the others.

What the work found, which changed the design:

- **`getLag` could not be the lag.** It is `MAX(position) − last_position` over the whole log, but a cursor only ever lands on events the processor's selection matched (`SqlEventFetcher` says so). A consumer of a rare event type that has everything shows a large "lag" for ever. The new `ProcessorManagementService.getBacklog` counts against the processor's own selection (`buildBacklogQuery`, the fetch predicate minus the xmin bound), and the engine exposes each processor's selection as `EventProcessorHandle.selectionFor`. `getLag` stays, documented as the distance to the head of the log. A Postgres test shows the two disagreeing (0 pending, `getLag` at least 4).
- **The outbox's `getCursor` writes.** It refreshes `leader_instance` and `leader_heartbeat` on every read, so a sampler reading it would write on every sample and attribute the heartbeat to itself. `ProgressTracker` gained `peekCursor` (a read with no side effect); the sampler, `getLag` and `getBacklog` use it. A Postgres test shows `getCursor` changing the leader column and `peekCursor` not.
- **Label mapping.** The new gauges all use `processor`, so they join with the existing poller metrics. A view's processor id is its name; an outbox publisher's is the JSON pair `["topic","publisher"]`. The per-area counters (`view`, `publisher`) still use their own labels.
- **No `crablet.poller.errors` counter.** The per-area failure counters and the `FAILED` status already cover it.
- **Not done here:** the wallet example does not yet run the sampler or export OTLP; that is step 3, where both are wired and the "metrics appear in an OTLP export" check is made.

Tests: unit (the sampler, the gauges, a failing round, the service's reading of the row, the cap, `selectionFor`) and Postgres (the rare-type consumer, the first-event age, the tag clauses, `peekCursor`). Two deliberate breaks, the selection dropped from the backlog query and a status gauge stuck at 1, were each caught.

Not covered: the lag in seconds on a very large table (measure in step 3 with the load script), and the sampler against a real views processor end to end (step 3).

### 2. The dashboard as code - done (2026-10-08)

- `ops/grafana/crablet-dashboard.json`: 31 panels in five rows (healthy, keeping up, failing, the write side, storage), with `Data source`, `Processor` and `View` variables and a leader-change annotation. **Generated** by `scripts/build-dashboard.ts` (`bun run dashboard:build`), so panel ids and grid positions are not edited by hand. The `Instance` variable the plan listed is not there: every instance reports the same values and the queries take the `max`.
- `ops/grafana/alerts.yaml`: six rules (a processor FAILED, a processor with no leader, a consumer behind more than 300 s for 5 min, handler failures, undecodable stored events, bytes per event above 3000). Thresholds are constants in the file: Grafana's rule files take no variables.
- `scripts/dashboard.test.ts` (in `test:unit`): the committed JSON equals the generator's output; panel ids and titles are unique and none overlaps; **every `crablet_*` name in a panel, variable, annotation or alert exists in `metrics-otel` under the Prometheus name it arrives with**, derived from each metric's `id` and `type`; every metric has a panel or alert or an entry in `NO_PANEL` with a reason (two do: the backoff's internal empty-poll count, and the per-event-type append count, an unbounded label). Three deliberate breaks (a renamed metric, a hand-edited JSON, a wrong name in an alert) each failed it.
- `ops/grafana/README.md`: how to import or provision.

Measured, not assumed: all 39 metrics were exported by the Effect exporter to a `grafana/otel-lgtm` container and their names read back from Prometheus. Counters keep their name (no `_total`), gauges gain `_ratio`, timers become `<name>_milliseconds_bucket|count|sum`. The dashboard and the alert file were then mounted into a fresh container: both loaded, all 42 panel queries returned data through Grafana's query API, and the six rules evaluated with health `ok` (the two the spike's data should trip, undecodable events and handler failures, fired and went pending).

What this step did not do:

- **The last error text.** The plan wanted a table of each processor's last error. A metric cannot carry free text, so it is not on the dashboard; it comes from the progress tables, so it belongs to the admin API (step 4) or a Postgres data source an adopter adds. Logs, which do carry the error, are a Loki query away in the lgtm stack.
- **Live data from the wallet example.** The data came from a script that updated every metric, not from a running application; the wallet is wired in step 3.
- **Another Grafana or Prometheus version.** Only the lgtm image was tried.

### 3. A local stack to see it - done (2026-10-08)

- `ops/compose.yaml` (two services: Postgres 18 and `grafana/otel-lgtm` pinned to `0.35.0` by version and digest, with the dashboard, a provider file and the alert rules mounted in) and `ops/grafana/provider.yaml`. No multi-container topology.
- The wallet example exports over OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (`src/Observability.ts`: `Otlp.layerJson` from `effect/observability`, nothing to install; off otherwise), runs `monitorProcessors` over its views, automation and outbox (`monitorBackgroundProcessors`), and `monitorStorage` every minute.
- `examples/wallet-example-app/scripts/load.ts`: a steady mixed load (deposits, withdrawals, transfers, and some commands that fail on purpose), `--rate` and `--seconds`.
- `docs/guides/dashboard.md`: try it, what each row shows, the three things to put in an application, using your own Collector and Grafana, what to do when a panel is red, what it costs.

Checked end to end, with the wallet application running against the compose stack (not a script standing in for it):

- All 41 panel queries were run through Grafana: 35 return data. The six empty ones are counters that never fired in the run (view, automation and outbox failures, undecodable events, contention, reads that waited).
- Under `load.ts --rate 250` the consumer lag rose to 3,865 events and 34 s and drained to 0 after the load, on the lag panels' own gauges. At 20 commands a second the lag was 0 when sampled after the run (it was not watched during it). **The example's defaults (batch 100, one-second polling) fall behind at a few hundred commands a second**; the guide says so.
- Spans (`crablet.command`, `crablet.eventstore.append`, `crablet.poller.batch`, plus the HTTP and SQL spans) reached Tempo, and logs reached Loki with `trace_id`.
- SIGTERM stopped the application within seconds. (That the last buffered batch of metrics was flushed on the way out was not checked.)
- The cost of the sampler's query on 2 million events: 0 to 14 ms for type and tag selections, 97 ms in the worst case (a new processor whose selection matches every event, stopped by the 100 000 cap), including the tag-key table. Nothing needed changing.

Found on the way, and fixed: the wallet example **crashed on its second start** against the same database (`relation "crablet_events" already exists`), because it applied every migration at every start. The docs say plainly that there is no migration runner; the example now applies the schema only to a fresh database (`migrateIfFresh`, with a Postgres test) and leaves one that has the event log alone. It does not detect an older or half-applied schema.

Not done: the "no leader" alert and the stale-series behaviour of a crashed leader (about five minutes in Prometheus) were not exercised by killing a process; the alert's `noDataState` is the only mechanism and is untried. The compose stack was tried with Docker Desktop on one machine, not in CI.

### 4. Optional: operate, not only watch - done (2026-10-08)

Two parts, in the planned order.

1. **`@crablet/processors-http`** ([ADR-0020](../adr/0020-processors-admin-api.md)): `processorsGroup` (`GET /admin/processors`, `POST /admin/processors/:kind/:id/pause|resume|reset`, problems as RFC 7807) and handlers over a list of sources (`{ kind, service, describe? }`, one per module). The list carries status, error count, last error, cursor, backlog (step 1's `getBacklog`), backoff and an optional description. To get the failure details the base `ProcessorManagementService` gained `getAllDetails`, which the views, automations and outbox services fill from their progress tables.
   - **Authorization is required.** Every endpoint carries `ProcessorsAuthorization` (a bearer-token `HttpApiMiddleware`); the application provides it (`authorizationFrom(check)`), or the server does not start (`Service not found: ...ProcessorsAuthorization`). The wallet mounts the API only when `WALLET_ADMIN_TOKEN` is set, and compares the token in constant time. A check that fails is a 401, one that dies a 500; neither lets the request through.
   - **Decided before publishing** (the plan said to): the evolution rules (fields are added, never removed or retyped; a changed meaning gets a new path), what `reset` means (clears the error count, sets `ACTIVE`, resumes; **does not move the cursor**), and no `leader` column (the progress tables record who registered a view, not who leads it).
2. **`examples/processors-admin-ui`**, a generic Foldkit page: a table (processor and description, status, failures with the last error, what waits and for how long, cursor), Pause / Resume, and Reset behind a confirmation. Its client is derived from `processorsGroup` alone and it imports nothing from any application, so it works against anything that mounts the group. The token is kept in memory only; a 401 ends the session. A last error with a zero count (after a reset) is shown as history.

Tests: the package (12, no database: a fake service through a web handler: authorization, listing, actions, the encoded outbox id, 404s, duplicate kinds, the OpenAPI scheme, the start-up failure without an authorization); `admin-api-e2e.test.ts` (6, the wallet's real processors on Postgres: 401s, the list across the three modules, pause holding events back and resume catching up, a `FAILED` view reset, the outbox's JSON-pair id); the page (28: stories on `update`, scenes on the real `view`, error mapping, base URL and bearer header) and `page-against-server.test.ts` (5, the page's own `update` and commands against the real wallet on Postgres). Run live: the wallet with `WALLET_ADMIN_TOKEN`, the Vite dev server in front, the list and an outbox pause through the proxy; without the token the route is a 404 and absent from the OpenAPI description.

Found on the way:

- **A claim of mine was wrong, and the test showed it.** I had written that the admin API "cannot be mounted without an authorization" at the type level. The layer's type is `Layer<never, never, HttpRouter>`: the requirement is invisible to the compiler. It fails closed at **runtime**: a real server layer fails to build (`Service not found: ...ProcessorsAuthorization`), and through a web handler the first request is refused. The ADR, the README and the tests now say that; a compile-time guarantee would need a different design.
- **`getLag` and the outbox's `getCursor`** (step 1) were already known; here `reset` was found to leave the last error's *text*, so the page shows an error with a zero count as history rather than as a current failure.
- **The wallet's automation id** is `wallet-opened-welcome-notification`, not the handler's name; the e2e test caught the wrong description key.
- Stubbing `globalThis.fetch` per test does not work with Effect's fetch client, which captures it once: tests supply `FetchHttpClient.Fetch`.

Not done:

- The page was **not run in a browser** (none is available here): its `view` is exercised by scene tests, and its bundle builds and is served, but nobody has looked at it.
- The **evolution rules are not enforced** by a test that compares the API description with a committed copy.
- The **admin API has no audit trail**: who paused what is not recorded.
- Grafana does not link to the page; the dashboard guide does.

### 5. Keep it honest

- CONTRIBUTING: adding a metric means adding it to the dashboard test's expectations or saying why it has no panel.
- Update `docs/reference.md#operating-it` and the `metrics-otel` README with the new metrics.

## Risks and costs

- **The backlog query counts up to 100 000 matching events per processor per sample** (and reads the first one's time). It follows the fetch's indexes, but a selection that matches few events over a long log may scan far; measure it on a large table in step 3 and lengthen the interval or lower the cap if it shows.
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
2. ~~Lag sampled by every instance or by the leader only?~~ Decided: every instance (built).
3. ~~Is the admin API (step 4) in scope?~~ Decided: yes (built, with a generic Foldkit page).
4. Where does `ops/` live: in this repository (recommended, so the test can check it), or a separate one?
