# Contributing

Thank you for looking. This project is **experimental and pre-release**: the API changes often and a breaking change is accepted when it is worth it
([ADR-0013](docs/adr/0013-api-evolution-additive-vs-breaking.md)). Read [`docs/README.md`](docs/README.md) first if you have not used it yet.

## Set up

You need **Bun 1.4+** (CI uses 1.4.2), **Node 24+** (`.nvmrc`), and **Docker** for the integration tests.

```bash
git clone https://github.com/rodolfodpk/ts-effect-crablet.git
cd ts-effect-crablet
bun install
```

## Run the checks

```bash
bun run typecheck          # tsc --noEmit across the workspace, and the course UI
bun run test:unit          # fast, no database, runs under Bun
bun run test:unit:coverage # the same with an lcov report at coverage/lcov.info
bun run test:integration   # real Postgres through Testcontainers (Docker), runs under Node
```

Coverage of both suites, merged into one report (`coverage/lcov.info`; takes about 5 minutes, Docker needed): `bun run test:coverage`. How the merge counts lines, and why: [the coverage plan](docs/plans/test-coverage.md).

**Coverage may not go down.** CI fails when a package's merged line coverage falls below its entry in [`coverage-baseline.json`](coverage-baseline.json) (by more than the 0.3-point tolerance). Add tests for what you changed; when coverage went up, raise the baseline with `bun run coverage:baseline` and commit the file. Lowering a baseline is done by hand, with the reason in the commit message. Only the packages count; the examples are reported in the log but not gated.

CI runs exactly these three (typecheck, unit with coverage, integration) on every push and pull request to `main`. There is no linter or formatter configured; match the
style of the file you are in.

### Run one test

```bash
bun test packages/commands/test/quickstart.test.ts                      # a unit test
node --test packages/eventstore/test/integration/storage.test.ts        # an integration test (needs Docker)
```

Unit tests live in `packages/*/test/` and `examples/*/test/`; integration tests in a `test/integration/` folder next to them. Integration tests run under **Node**, not
Bun, because the Testcontainers PostgreSQL module hangs under Bun. Each integration file starts its own container (`startTestDb` from
[`@crablet/test-support`](packages/test-support/README.md)).

Node runs the TypeScript files directly by stripping types, which rejects TypeScript-only syntax such as constructor parameter properties
(`constructor(private x: number)`); write explicit fields.

## Where things are

[`docs/reference.md#packages`](docs/reference.md#packages) lists every package and example, and each has its own README. The shape in one line: `eventstore` (the log) ->
`commands` (events, models, commands) -> `commands-http` (REST); `event-poller` -> `views`, `outbox`, `automations` (pollers) -> `views-http` (consistent reads).

## Common tasks

**Change the database schema.** Add a new numbered file in `packages/db-migrations/sql/` (`V13__...sql`) and list it in `packages/db-migrations/src/index.ts`, rather than
editing a migration that has been applied. Test it from the state before it: see `packages/eventstore/test/integration/migration-v11.test.ts`, which starts the test
database at a chosen migration with `startTestDb({ migrations })`. A migration that locks a table says so in its header.

**Change the HTTP API.** The OpenAPI descriptions in [`docs/api/`](docs/api) are checked in, and a unit test fails when they are stale. Regenerate the wallet's with
`bun run docs:api`, and the course app's with `node scripts/generate-openapi.ts` from `examples/course-enrolment-app`. The diff is the API change.

**Change an event.** Follow [Evolving events](docs/evolving-events.md). Run the wallet's `verify-events.ts` against representative data, and update the committed change-impact
baseline (`test/fixtures/model-impact-baseline.json` in the wallet app) with a reason for each entry.

**Run a diagnostic.** `packages/*/diagnostics/` holds experiments that measure rather than assert (real Postgres, Docker). CI does not run them. For example:

```bash
N=200000 node --test packages/eventstore/diagnostics/storage.diagnostic.ts    # then read the DIAG lines
```

Each file's first lines say what it measures and which environment variables it reads. Measure with the real code paths: an approximation of a query has misled this
project before ([the reliability report](docs/plans/reliability-and-scale-diagnostic.md) records where).

## Documentation

- **Code in documents comes from tested files.** A block tagged `<!-- file: path#region -->` must equal the lines between `// #region name` and `// #endregion name` in
  that file; the sync tests (`guides-sync.test.ts`, `tutorial-sync.test.ts`) fail when they differ. Edit the source file, then paste the same lines into the document.
- **Links are checked.** `docs-links.test.ts` fails on a broken relative link, a broken `#anchor`, or a documentation path in a source comment that does not exist.
- **Decisions get a record** when they have a lasting effect on the shape of the code: add `docs/adr/NNNN-title.md` (status, context, decision, consequences) and list it in
  [`docs/adr/README.md`](docs/adr/README.md) under the right heading. One-off findings and gotchas go in [`NOTES.md`](NOTES.md), not in a decision record.
- **Plans are records.** A plan in `docs/plans/` is written before the work and kept after it; update its status in [`docs/plans/README.md`](docs/plans/README.md).
- **Diagrams are Mermaid** in fenced `mermaid` blocks (GitHub draws them), kept in [`docs/architecture.md`](docs/architecture.md) (the framework) and [`docs/c4-examples.md`](docs/c4-examples.md) (the two example applications). They are not
  checked against the code, so when a flow changes, change its diagram in the same commit.
- Prefer the same example domains as the existing documents: seat booking in the README, course enrolment in the tutorial, the wallet for the full application.

## Making a change

- One logical change per commit, with a message that says what changed and why. A breaking change updates every example, test and document in the same commit.
- Add or update tests with the change; a bug fix starts with a test that fails.
- Run the three checks above before you push. Integration tests are slower, so run the ones near your change while you work and the whole suite once at the end.
