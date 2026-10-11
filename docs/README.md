# Documentation

*Map · everyone · nothing to install · 2 minutes*

This is the one full map of the documents. Each folder holds one kind of document, so the folder tells you what kind of page you are on.

## New here? Read in this order

1. [The README](../README.md): what this is, what it is good at, and whether it fits (2 minutes).
2. [The quick start](../examples/quickstart/README.md): run a command with no database (5 minutes).
3. [The tutorial](./tutorial/README.md), steps 1 and 2: a rule in memory, then on Postgres. Each step is one page and ends with something that runs. Docker is needed from step 2.
4. [Consistency boundaries](./concepts/dcb-guide.md): why a command picks its own boundary.
5. [The glossary](./reference/glossary.md), whenever a word is unfamiliar.

## Start: learn by doing

| Page | What you get |
|---|---|
| [Quick start](../examples/quickstart/README.md) | One command, run on the in-memory store. No Docker. |
| [Tutorial](./tutorial/README.md) | A small service in five steps: in memory, Postgres, HTTP and OpenAPI, reading your own writes, a web page. |

## Concepts: understand the ideas

| Page | The idea |
|---|---|
| [Consistency boundaries (the DCB guide)](./concepts/dcb-guide.md) | A command declares the events its decision depends on; two commands conflict only when one changes what the other relied on. |
| [Views and delivery](./concepts/views-and-delivery.md) | What reaches a view, an automation or an outbox publisher, and how often: no event skipped, at least once, a view's batch applied once. |
| [Reading your own writes](./concepts/read-your-writes.md) | A command returns a marker; a read that carries it includes the write, or answers `503`. Pings for clients that did not write. |
| [Background processors](./concepts/background-processors.md) | One leader per module, fenced; what happens when an instance dies; one process or several deployments. |
| [Events over time](./concepts/events-over-time.md) | Changing an event, personal data, and a log that grows: what is solved and what is not. |
| [Architecture](./concepts/architecture.md) | The system and its core flows, in diagrams. |
| [C4 models](./concepts/c4-examples.md) | The two example applications, as context, container and component diagrams. |
| [Why not something else?](./concepts/why-not.md) | A transaction with locks, or an event store with streams: what each gives, and when to choose them instead. |
| [Questions adopters ask](./concepts/faq.md) | Effect, production, Postgres, speed, personal data, growth, adopting gradually, tenants, failures. |
| [Course enrolment as an Event Model](./concepts/event-model.md) | The README's example as events, commands and a view, laid out on a timeline. |

## Build: tasks while writing an application

| I want to... | Guide |
|---|---|
| Keep a read model (a table) up to date from events | [Add a view](./guides/build/add-a-view.md) |
| Change the schema and keep the queries checked | [The database workflow](./guides/build/database-workflow.md) |
| React to an event by issuing a command | [Add an automation](./guides/build/add-an-automation.md) |
| Call a command over HTTP, with a generated OpenAPI description | [Expose a command over HTTP](./guides/build/expose-a-command-over-http.md) |
| Test a command's decisions without a database | [Test a command](./guides/build/test-a-command.md) |
| Close a statement or a shift and open the next one | [Turn a period](./guides/build/turn-a-period.md) |
| Change an event that is already stored | [Evolving events](./guides/build/evolving-events.md) |

## Operate: tasks while running it

| I want to... | Guide |
|---|---|
| Run it for real: migrations, connections, the background processors | [Run it in production](./guides/operate/run-in-production.md) |
| See what it is doing and what it costs | [Monitor it](./guides/operate/monitor-it.md) |
| Watch it on a Grafana dashboard, with alerts | [See it on a dashboard](./guides/operate/dashboard.md) |
| Run it on a local Kubernetes cluster and break it on purpose | [Run the kind lab](./guides/operate/run-the-kind-lab.md) |

## Evidence: can I trust it?

| Page | What is in it |
|---|---|
| [Guarantees and evidence](./evidence.md) | Each guarantee, the test that checks it, the numbers measured and the known limits. |
| [Reliability and scale report](./history/plans/reliability-and-scale-diagnostic.md), [the kind lab](./history/plans/kind-lab.md) | The full records behind the numbers. |

## Reference: look things up

| Page | What is in it |
|---|---|
| [Commands and models](./reference/commands.md) | `defineCommand` options, what `decide` returns, error kinds and statuses, `defineModel`, `defineEvent`. |
| [Views](./reference/views.md) | `defineView` operations, column types, processor settings. |
| [HTTP](./reference/http.md) | Endpoints, command answers, read-consistency parameters and settings. |
| [Configuration](./reference/configuration.md) | `Crablet.layer` options, the wallet's environment variables and health endpoints. |
| [Metrics and spans](./reference/metrics.md) | Every metric and span the packages record. |
| [Database tables](./reference/tables.md) | The tables the framework owns. |
| [Packages, build and test](./reference/README.md#packages) | Every package and example, and the commands to build and test. |
| [Glossary](./reference/glossary.md) | Every word the documents use, in one sentence each. |
| [`wallet-openapi.json`](./api/wallet-openapi.json), [`course-enrolment-openapi.json`](./api/course-enrolment-openapi.json) | The generated HTTP APIs of the two example applications. |
| Package and example READMEs | Each folder under [`packages/`](../packages), [`examples/`](../examples) and [`tools/`](../tools) has one, listed in the [reference](./reference/README.md#packages). |

## Examples and tools

| Folder | What it is |
|---|---|
| [`examples/quickstart`](../examples/quickstart/README.md) | The quick start. |
| [`examples/course-enrolment-app`](../examples/course-enrolment-app/README.md), [`examples/course-enrolment-ui`](../examples/course-enrolment-ui/README.md) | What the tutorial builds. |
| [`examples/wallet-example-app`](../examples/wallet-example-app/README.md) | The framework at full size: five commands, four views, an automation, an outbox. |
| [`tools/chaos-ui`](../tools/chaos-ui/README.md) | A page for the kind lab: break the wallet's pods and watch who takes over. |
| [`tools/processors-admin-ui`](../tools/processors-admin-ui/README.md) | A page to list, pause, resume and reset the background processors. |

## Decisions and history

| Page | What it is |
|---|---|
| [Design decisions](./adr/README.md) | The architecture decision records (ADRs): one file per lasting decision, with its context and consequences. |
| [Plans](./history/plans/README.md) and the [work log](./history/NOTES.md) | Records of how the work went. You do not need them to use the project. |
| [CONTRIBUTING](../CONTRIBUTING.md) | Set up, run one test, change the schema or the API, and where a new page goes. |

The API is experimental and changes often ([ADR-0013](./adr/0013-api-evolution-additive-vs-breaking.md)). Where a document and the code disagree, the tests are the source of truth.
