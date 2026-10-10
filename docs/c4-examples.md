# C4 models of the examples

The [C4 model](https://c4model.com) describes a system at three zoom levels: **context** (the system among its users and neighbours), **containers** (the separately running
parts: applications and databases), and **components** (the parts inside one container). These are the models of the two applications you can run. For the framework's own flows, see
[Architecture](./architecture.md); for the code, the READMEs of [`course-enrolment-app`](../examples/course-enrolment-app/README.md),
[`course-enrolment-ui`](../examples/course-enrolment-ui/README.md) and [`wallet-example-app`](../examples/wallet-example-app/README.md).

Contents: [Course enrolment](#course-enrolment) · [Wallet](#wallet)

The diagrams are Mermaid's C4 syntax (GitHub draws them); the layout is automatic, so read the arrows and labels, not the positions.

## Course enrolment

The [tutorial](./tutorial/README.md)'s service: a course holds at most N students and a student takes at most 3 courses, decided together; one view; a web page.

### Level 1: context

```mermaid
C4Context
  title Course enrolment: system context

  Person(user, "Registrar or student", "Defines courses, subscribes students, watches the seat map")
  System(courses, "Course enrolment", "Decides enrolments against two rules at once, keeps a seat map up to date, and serves both over HTTP")
  System_Ext(tools, "Other API clients", "curl, any OpenAPI-generated client")

  Rel(user, courses, "Uses, through a web page")
  Rel(tools, courses, "Calls the REST API described by openapi.json")
```

### Level 2: containers

```mermaid
C4Container
  title Course enrolment: containers

  Person(user, "Registrar or student")
  System_Ext(tools, "Other API clients", "curl, OpenAPI clients")

  System_Boundary(sys, "Course enrolment") {
    Container(page, "Web page", "Foldkit, TypeScript, Vite", "course-enrolment-ui. Sends commands and marker reads through a typed client")
    Container(api, "API server", "Node, Effect HttpApi, port 8080", "course-enrolment-app. Commands, reads, live-update feed, OpenAPI, and the view processor in the same process")
    ContainerDb(db, "PostgreSQL 18", "docker compose", "The event log, the framework tables, and course_seats_view")
  }

  Rel(user, page, "Uses", "browser")
  Rel(page, api, "POST /api/commands/name, GET /api/courses, GET /api/views/changes", "HTTP, server-sent events; the dev server proxies it, or CORS if VITE_API_URL is set")
  Rel(tools, api, "Calls", "HTTP")
  Rel(api, db, "Appends events, reads the log and the view, LISTENs for progress", "SQL")
```

### Level 3: components of the API server

```mermaid
C4Component
  title Course enrolment: components of the API server

  Container(page, "Web page", "Foldkit")
  ContainerDb(db, "PostgreSQL", "event log, course_seats_view")

  Container_Boundary(api, "API server (course-enrolment-app)") {
    Component(cmdapi, "Command API", "commands-http", "POST /api/commands/define_course and subscribe, built from the two contracts; problem+json errors")
    Component(queryapi, "Query API", "views-http", "GET /api/courses and /api/courses/:courseId, wrapped in a consistent read that honours the marker")
    Component(feed, "Feed API", "server-sent events", "GET /api/views/changes: a ping when the seats view moves")
    Component(commands, "Commands and models", "commands", "DefineCourse and Subscribe; CourseModel and StudentModel; Subscribe decides on both with all(...)")
    Component(executor, "CommandExecutor and EventStore", "Crablet.layer", "Validates, loads the boundary, decides, appends if nothing newer, retries on a conflict")
    Component(processor, "Views processor", "event-poller and views", "Leader-gated by the views module's advisory lock (one lock for all views, not one per view); reads new events, runs the projector, moves the cursor")
    Component(projector, "CourseSeatsViewProjector", "ViewProjector", "Idempotent seat counter per course, using decodeStored")
    Component(hub, "ViewProgressHub", "views", "One LISTEN per process; wakes waiting reads and open feeds")
    Component(openapi, "OpenAPI and docs", "commands-http", "GET /openapi.json, optional /docs page")
  }

  Rel(page, cmdapi, "Writes", "HTTP")
  Rel(page, queryapi, "Reads with the marker", "HTTP")
  Rel(page, feed, "Listens", "SSE")
  Rel(cmdapi, commands, "Runs")
  Rel(commands, executor, "Decisions become one conditional append")
  Rel(executor, db, "append_events_if, tag queries", "SQL")
  Rel(processor, db, "Fetches events after the cursor", "SQL")
  Rel(processor, projector, "Hands each batch")
  Rel(projector, db, "Writes course_seats_view", "SQL")
  Rel(queryapi, db, "SELECT from the view", "SQL")
  Rel(queryapi, hub, "Waits until the view passes the marker")
  Rel(feed, hub, "Subscribes to progress")
  Rel(hub, db, "LISTEN crablet_view_progress", "SQL")
```

Where to read the code: the contracts and commands in `src/domain/`, the API in `src/CourseApi.ts` and `src/CourseApp.ts`, the reads in `src/api/`, the projector in `src/views/`.
The page's own structure (Model, Messages, `update`, `view`, subscriptions) is in [tutorial step 5](./tutorial/05-a-page-that-uses-it.md).

## Wallet

The framework at full size: five commands, four views, an automation, an outbox and an HTTP API in one process.

### Level 1: context

```mermaid
C4Context
  title Wallet: system context

  Person(client, "Wallet client", "An application or person opening wallets, depositing, withdrawing, transferring")
  System(wallet, "Wallet service", "Decides money movements atomically, keeps balances, transactions, summaries and statements, notifies new wallets, and publishes events")
  System_Ext(broker, "Event consumer", "Where the outbox publishes. In this example a logging publisher stands in")
  Person(ops, "Operator", "Verifies stored events before a deploy, reads the storage report")

  Rel(client, wallet, "Calls the REST API")
  Rel(wallet, broker, "Publishes wallet events per topic")
  Rel(ops, wallet, "Runs verify-events and report-storage")
```

### Level 2: containers

```mermaid
C4Container
  title Wallet: containers

  Person(client, "Wallet client")
  Person(ops, "Operator")
  System_Ext(broker, "Event consumer", "stands in as a logging publisher")

  System_Boundary(sys, "Wallet service") {
    Container(api, "Wallet application", "Node, Effect, port 8080", "One process: HTTP API, and the views, automations and outbox processors sharing one connection pool")
    ContainerDb(db, "PostgreSQL", "wallet_db", "The event log, the framework tables, and the wallet view tables (V100 and up)")
    Container(scripts, "Operator scripts", "Node", "verify-events, report-storage, generate-openapi")
  }

  Rel(client, api, "POST /api/commands/name, GET /api/wallets/...", "HTTP")
  Rel(api, db, "Appends events, reads the log, projects views, LISTEN", "SQL")
  Rel(api, broker, "publishBatch per topic wallet-events", "outbox publisher")
  Rel(ops, scripts, "Runs")
  Rel(scripts, db, "Read-only: decodes events, reads the catalog", "SQL")
```

### Level 3: components of the wallet application

```mermaid
C4Component
  title Wallet: components of the application

  Person(client, "Wallet client")
  ContainerDb(db, "PostgreSQL", "event log and view tables")
  System_Ext(broker, "Event consumer")

  Container_Boundary(app, "Wallet application") {
    Component(cmdapi, "Command API", "commands-http", "open_wallet, deposit, withdraw, transfer_money, close_wallet, from WalletContracts")
    Component(queryapi, "Query API", "views-http", "getWallet, getWalletTransactions (keyset paging), getWalletSummary; consistent reads")
    Component(commands, "Commands", "commands", "Five commands over WalletModel; transfer decides on both wallets with all(...)")
    Component(period, "Statement periods", "WalletPeriodModel (.period)", "The framework closes last month's statement and opens this month's in the command's own append, before a deposit, withdrawal or transfer; nothing is written if the command is refused")
    Component(executor, "CommandExecutor and EventStore", "Crablet.layer", "Conditional append with retries; idempotency per operation id")
    Component(views, "Views processor", "event-poller and views", "Four projectors: balance, transactions, summary, statement. The statement projector is the idempotent worked example")
    Component(auto, "Automations processor", "automations", "WalletOpenedAutomation: WalletOpened -> SendWelcomeNotification, idempotent per wallet")
    Component(outbox, "Outbox processor", "outbox", "Topic wallet-events, selected by the wallet tags, published through a publisher")
  }

  Rel(client, cmdapi, "Writes", "HTTP")
  Rel(client, queryapi, "Reads", "HTTP")
  Rel(cmdapi, commands, "Runs")
  Rel(commands, period, "Prepares")
  Rel(commands, executor, "Appends")
  Rel(executor, db, "append_events_if", "SQL")
  Rel(views, db, "Fetches events, writes four view tables", "SQL")
  Rel(queryapi, db, "SELECT from the views", "SQL")
  Rel(auto, db, "Fetches WalletOpened", "SQL")
  Rel(auto, executor, "Runs the follow-up command")
  Rel(outbox, db, "Fetches events by tag", "SQL")
  Rel(outbox, broker, "publishBatch")
```

Where to read the code: the domain in `src/domain/` (one file per command), the composition in `src/WalletApp.ts` (`startBackgroundProcessors` starts the three processors),
the views in `src/views/`, the automation in `src/automations/`, the read endpoints in `src/api/`. The statement view is written but this example has no read endpoint for it.

### Level 2 again: deployed as separate roles

The same image, started with different roles ([ADR-0022](./adr/0022-runtime-roles.md)). The diagram above is the default, `WALLET_ROLES=all`, one process.

```mermaid
C4Container
  title Wallet: containers, deployed as separate roles

  Person(client, "Wallet client")
  Person(ops, "Operator")
  System_Ext(broker, "Event consumer", "stands in as a logging publisher")

  System_Boundary(sys, "Wallet service") {
    Container(api, "wallet-api, two or more pods", "WALLET_ROLES=api", "The HTTP API, the reads and the admin API. Scales with load; holds no leader lock and no LISTEN for events")
    Container(workers, "wallet-workers, two or more pods", "WALLET_ROLES=views,automations,outbox", "Each module leads in one pod at a time, by an advisory lock per module; the others are warm standbys")
    Container(job, "Schema job", "Flyway, run before a deploy", "The only thing that applies migrations: V1 to V13 (the framework) and V100 and up (the wallet), in one history")
    ContainerDb(db, "PostgreSQL", "wallet_db", "The event log, the view tables, the processors' progress and the leader locks")
  }

  Rel(client, api, "POST /api/commands/name, GET /api/wallets/...", "HTTP")
  Rel(ops, api, "Pause, resume, reset a processor", "admin API, bearer token")
  Rel(api, db, "Appends events, reads views; LISTEN for view progress", "SQL")
  Rel(workers, db, "Polls the log by cursor, projects views, holds the module locks, LISTEN for wake-ups", "SQL")
  Rel(workers, broker, "publishBatch per topic wallet-events", "outbox publisher")
  Rel(job, db, "Applies the schema, once", "SQL")
```

### The kind lab

What runs where when the wallet is run on a local Kubernetes cluster and broken on purpose ([Run the kind lab](./guides/run-the-kind-lab.md)). The pages and the server behind the chaos page run on your computer, because a browser cannot run `kubectl`.

```mermaid
C4Container
  title The kind lab: containers

  Person(user, "You")

  System_Boundary(laptop, "Your computer") {
    Container(chaosui, "Chaos page", "Foldkit, port 5175", "Leaders, pods, faults for N minutes, the load, a consistency check, a reset")
    Container(chaossrv, "Lab server", "Node, 127.0.0.1:5174", "Runs kubectl, reads Postgres, steers the load generator, marks Grafana")
    Container(procui, "Processors page", "Foldkit, port 5173", "Status of each processor; pause, resume, reset")
  }

  System_Boundary(cluster, "kind cluster crablet-lab, three nodes") {
    Container(api, "wallet-api, two pods", "WALLET_ROLES=api", "HTTP API and admin API")
    Container(workers, "wallet-workers, two pods", "WALLET_ROLES=views,automations,outbox", "The processors; one leader per module")
    ContainerDb(db, "PostgreSQL", "no volume", "Emptied by the reset, and by deleting its pod")
    Container(load, "Load generator", "node scripts/load.ts, control port 9090", "Bursts of commands; start, pause and settings change while it runs")
    Container(grafana, "Grafana", "otel-lgtm, port 3000", "Receives the pods' metrics, traces and logs over OTLP and shows the Crablet dashboard; no volume, so no history across a restart")
  }

  Rel(user, chaosui, "Opens, chooses faults, reads results", "browser")
  Rel(user, procui, "Opens", "browser")
  Rel(chaosui, chaossrv, "State, run, kill, load, verify, reset", "HTTP /api")
  Rel(chaossrv, workers, "delete pod, rollout, debug (a network cut)", "kubectl")
  Rel(chaossrv, api, "delete pod", "kubectl")
  Rel(chaossrv, db, "Leaders, counts, the consistency checks", "SQL")
  Rel(chaossrv, load, "Start, pause, set the range", "HTTP, by a port-forward")
  Rel(chaossrv, grafana, "A mark for every fault", "annotations API")
  Rel(procui, api, "Lists and acts on the processors", "admin API")
  Rel(load, api, "Sends commands", "HTTP")
  Rel(api, db, "Appends, reads", "SQL")
  Rel(workers, db, "Polls, projects, holds the locks", "SQL")
```
