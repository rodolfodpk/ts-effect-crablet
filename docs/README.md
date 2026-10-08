# Documentation

Where to start depends on what you want. If you are new, follow the path below in order; each step is short and ends with a link to the next.

## New here? Read in this order

1. [The README](../README.md) - what this is, what it is good at, whether it fits (2 minutes).
2. [The quick start](../examples/quickstart/src/quickstart.ts) - run a command with no database: `node examples/quickstart/src/quickstart.ts` (5 minutes).
3. [The tutorial](./tutorial/README.md), steps 1 and 2 - a rule in memory, then on Postgres (Docker is needed from step 2). Each step is one page and ends with something that runs.
4. [The DCB guide](./dcb-guide.md) - why a command picks its own boundary, with a transfer between two accounts. [Architecture](./architecture.md) shows the same in diagrams.
5. [The glossary](./glossary.md) - whenever a word is unfamiliar.

## By what you want to do

| I want to... | Read |
|---|---|
| See how it fits together | [Architecture](./architecture.md): the system and the core flows, in diagrams; [C4 models](./c4-examples.md) of the two example applications |
| Understand the idea | [DCB guide](./dcb-guide.md), [the seat booking as an Event Model](./event-model-seat-booking.md) |
| Build a small service step by step | [Tutorial](./tutorial/README.md) (in memory, Postgres, HTTP + OpenAPI, read-your-writes, a UI) |
| See a complete application | [`examples/wallet-example-app`](../examples/wallet-example-app) |
| Do a specific task (add a view, add an automation, expose a command, test, run, monitor, dashboard) | [Task guides](./guides/README.md) |
| Change an event without breaking the log | [Evolving events](./evolving-events.md) |
| Know what a package or example is for | the `README.md` in each folder under [`packages/`](../packages) and [`examples/`](../examples), also linked from the [reference](./reference.md#packages) |
| Look up command options, delivery guarantees, operations, packages, build and test | [Reference](./reference.md) |
| See the HTTP API | [`wallet-openapi.json`](./api/wallet-openapi.json), [`course-enrolment-openapi.json`](./api/course-enrolment-openapi.json) (generated; `bun run docs:api` regenerates the wallet's) |
| Learn a word | [Glossary](./glossary.md) |
| Know why it is built this way | [Design decisions](./adr/README.md), the architecture decision records (ADRs); start with the four marked "start here" |
| Contribute (set up, run one test, change the schema or the API) | [CONTRIBUTING](../CONTRIBUTING.md) |
| Know how reliable it is, and what was measured | [Reliability and scale report](./plans/reliability-and-scale-diagnostic.md) |

## What each kind of document is

| Kind | Where | Meant to be |
|---|---|---|
| Teaching | `tutorial/`, `guides/`, `dcb-guide.md`, `evolving-events.md` | Read in order or by task. Their code comes from tested files, so it runs. |
| Reference | `reference.md`, `architecture.md`, `api/`, `glossary.md` | Looked up. |
| Decisions | `adr/` | The lasting "why". One file per decision; read the ones you need. |
| History | `plans/`, [`NOTES.md`](../NOTES.md) | Records of how the work went, with the measurements. Not a roadmap, and not needed to use the project. |

The API is experimental and changes often ([ADR-0013](./adr/0013-api-evolution-additive-vs-breaking.md)); the tests are the source of truth where a document and the code disagree.
