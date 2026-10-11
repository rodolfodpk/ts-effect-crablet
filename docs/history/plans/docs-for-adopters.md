# Plan: documentation that convinces adopters

**Status:** in progress (2026-10-11). Written after a review of the documents as a technical editor; the decisions below were taken by the owner the same day. Each phase is its own commit.

## Context

The docs serve someone who already believes in DCB. They are accurate, their code is tested, and they are layered in principle. An adopter arrives with three questions:
- What problem does this solve for me?
- Why not what I already use?
- Can I trust it?

Today those answers are missing or several clicks deep:
- The README leads with the mechanism and a seat example that aggregates already handle.
- There is no positioning or FAQ.
- The trust evidence sits in `docs/history/plans/` under "history".
- The "why" is spread across ADRs and `reference.md` prose.
- There are four overlapping maps.
- The developer and operator content is mixed.
- The quickstart README promises output that the README never shows.

**Decisions taken (2026-10-11):**
- Course enrolment becomes the teaching domain for the README and the quickstart.
- The files are moved for real, so the layers match the folders.
- The docs stay GitHub Markdown, with no site generator.
- Moving `NOTES.md` reverses step 6 of `docs/history/plans/newcomer-accessibility.md` ("many links; no gain"). The new plan records that.

**Outcome:** a reader understands the problem and the payoff in 2 minutes, and finds the guarantees, the limits and the comparison without reading a plan or an ADR.

## What the moves touch (checked)

- **Link checking.** `packages/commands/test/docs-links.test.ts` checks Markdown links and `docs/...md` paths in source comments. It does not check YAML comments: `.github/workflows/ci.yml` (which names `NOTES.md` and `docs/history/plans/test-coverage.md`) and `ops/grafana/alerts.yaml` (which names `docs/history/plans/dashboard.md`) need a manual `git grep`.
- **Guide sync.** `packages/commands/test/guides-sync.test.ts` hardcodes `docs/guides/build/evolving-events.md` and does a flat `readdirSync("docs/guides")`.
- **Tutorial sync.** `examples/course-enrolment-app/test/tutorial-sync.test.ts` reads `docs/tutorial/*` and `docs/api/course-enrolment-openapi.json`.
- **`docs/api/` is load-bearing.** `examples/wallet-example-app/src/api/WalletOpenApi.ts` resolves it at runtime, `scripts/generate-openapi.ts` writes there, and three tests compare against it. **`docs/api/` stays where it is.**
- **Workspaces.** The root `package.json` lists `examples/*` and has scripts naming `tools/chaos-ui` and `tools/processors-admin-ui`. Moving these to `tools/` means adding `tools/*` to the workspaces, updating those scripts, running `bun install` (which updates the lockfile), and fixing `docs/guides/operate/dashboard.md` and `run-the-kind-lab.md`.
- **The README code block exists in three hand-synced copies.** They are the README, `examples/quickstart/src/quickstart.ts` and `packages/commands/test/quickstart.test.ts`. Nothing checks the README copy. `examples/quickstart/test/quickstart.test.ts` pins output "the README says", but the README doesn't show it.
- **The DCB guide's race table** comes from `packages/commands/test/support/transfer.ts` and its Postgres race test. The wallet has no equivalent race test, so the transfer example **stays** as it is.
- **Seat booking also appears in** the conflict sequence diagram in `docs/concepts/architecture.md`, the glossary's example events, `docs/concepts/event-model-seat-booking.md` and `docs/README.md`.

## Target tree

```
README.md                 problem, payoff, 30-second run, 4 links, status
ROADMAP.md                next, deliberately undecided, path to 1.0
docs/
  README.md               the one full map
  tutorial/               unchanged
  concepts/               dcb-guide, architecture, c4-examples, event-model (course enrolment)
                          + new: views-and-delivery, read-your-writes, background-processors,
                          events-over-time, why-not, faq
  guides/build/           add-a-view, add-an-automation, expose-a-command-over-http,
                          test-a-command, evolving-events, turn-a-period, database-workflow
  guides/operate/         run-in-production, monitor-it, dashboard, run-the-kind-lab
                          + new: configure, failure-modes, runbooks
  reference/              README.md (was reference.md), glossary
                          + new: commands, views, configuration, http, metrics, tables
  api/                    unchanged (load-bearing)
  evidence.md             new
  adr/                    records only, every one with a status
  history/                plans/ (moved), NOTES.md (moved)
examples/                 quickstart, course-enrolment-app, course-enrolment-ui, wallet-example-app
tools/                    chaos-ui, processors-admin-ui
```

File names stay the same when moved. New pages appear only in the phase that writes them.

## Phases (each is one commit, or a small series; `bun run typecheck` and `bun run test:unit` pass after each)

### 0. Record the plan
Write this plan as `docs/history/plans/docs-for-adopters.md` with the status Proposed, and add its row to `docs/history/plans/README.md`. Phase 2 moves it along with the other plans.

### 1. Quick fixes
- Remove `NOTES.md` from the README's map.
- Fix the claim in `examples/quickstart/README.md`. The README gains the output in phase 4, so for now point to the test that pins it.

### 2. Move the files (`git mv` only, no rewriting)
- Move the files into the target tree, keeping their names.
- `guides-sync.test.ts`: walk `docs/guides/**` recursively and drop the hardcoded path of `evolving-events`.
- Fix every path that `docs-links` reports, plus the YAML comments above.
- Make the workspace and script changes for `tools/`.
- Leave a one-line stub at the old paths of `docs/concepts/dcb-guide.md`, `docs/reference/README.md` and `docs/guides/build/evolving-events.md`. Follow the pattern of `docs/tutorial/course-enrolment.md`.
- Update the folder rules in `CONTRIBUTING.md#documentation`: where a new page goes, and that plans live in `docs/history/plans/`.

**Done when:** the tests pass, `git grep -n "docs/history/plans/\|tools/chaos-ui\|tools/processors-admin-ui\|\bNOTES.md"` shows only new paths, and `bun run` of the chaos and admin UI scripts still starts them.

### 3. One map
- `docs/README.md` becomes the only full map, grouped as Start, Concepts, Build, Operate, Reference, Evidence, Decisions, History.
- Cut the README's "Where next" table to 4 rows: try it, learn it, concepts, the map.
- Reduce `guides/README.md` to the two tracks.
- From this phase on, every page that is written or touched gets a first line: *kind · for whom · prerequisites · time*.

### 4. The README and the quickstart in one domain
- Rewrite `examples/quickstart/src/quickstart.ts` as course enrolment, with both rules through `all({ course, student })`. Take the code from `docs/tutorial/02-postgres-and-the-second-rule.md`. Update the pinned lines in `examples/quickstart/test/quickstart.test.ts`.
- Remove the three copies of the code block:
  - Tag the README block `<!-- file: examples/quickstart/src/quickstart.ts#readme -->`, using `// #region readme`.
  - Add `README.md` to the files that `guides-sync.test.ts` checks.
  - Delete the copy in `packages/commands/test/quickstart.test.ts`, or make it import from the quickstart.
- In the README, in this order:
  1. The problem in 3 lines, adapted from the opening of the DCB guide.
  2. The two rules as one command.
  3. The run command and its printed output.
  4. The step 2 race: one of two concurrent subscriptions wins. Link to `examples/course-enrolment-app/test/integration/step2-postgres.test.ts`.
  5. "Why" bullets written as outcomes for the user.
  6. The "two commands that conflict" diagram instead of the system diagram.
  7. A link to the DCB specification (dcb.events).
  8. The status note, with how to try the code without npm and a link to `ROADMAP.md`.
- The README's Postgres snippet: either add the database and migration lines, or label it as an excerpt and link to tutorial step 2.
- Sweep the remaining seat-booking mentions:
  - `docs/concepts/architecture.md`: the conflict diagram.
  - The glossary's example events.
  - `docs/README.md`.
  - Replace `event-model-seat-booking.md` with `concepts/event-model.md` for course enrolment, and leave a stub at the old path.
  - Update the domain rule in `CONTRIBUTING.md`: course enrolment for teaching, the wallet as the full app, and the transfer in the DCB guide.

### 5. Concept pages
- Write each page from content that already exists, and link the ADRs at the bottom:
  - `views-and-delivery`: the "Views" paragraph of the reference, plus ADR-0012 and ADR-0023.
  - `read-your-writes`: ADR-0015, ADR-0014 and tutorial step 4.
  - `background-processors`: ADR-0006, 0007, 0021, 0022 and 0024.
  - `events-over-time`: a summary of `guides/build/evolving-events.md`, `personal(...)` placed next to "tags cannot be erased", and the open retention question.
- Leave the DCB guide's content as it is, and add a header line.
- In `docs/adr/README.md`, replace "start here" with a pointer to `concepts/`. Make sure every ADR has a `## Status` section (ADR-0009 already does).

### 6. Positioning and the FAQ
- `concepts/why-not.md`:
  - When a transaction with `SELECT … FOR UPDATE` or `SERIALIZABLE` is enough, and when it stops being enough.
  - How this differs from stream-based stores (EventStoreDB/Kurrent, Emmett, Marten-style).
  - Which parts of the DCB spec this implements, with a link to the mapping in the DCB guide.
  - When *not* to use this.
- `concepts/faq.md`: personal data and GDPR, retention, adopting it gradually in a CRUD app, multi-tenancy, "Do I need to know Effect?", Postgres only.

### 7. Evidence
`docs/evidence.md`:
- **One row per guarantee:** no lost update within a boundary, no skipped event, at-least-once delivery, fenced leaders, reads that are never stale.
- **For each guarantee, the test that checks it**, linked: the conformance suite, the race tests with barriers, the kind lab, the coverage gate. Mutation testing is listed as proposed.
- **The numbers, each with its source and how firm it is.** Take them from `history/plans/reliability-and-scale-diagnostic.md` and `kind-lab.md`. Quote them as measured there; for example, 476 bytes is the event row and about 1.2 KB is the total per event with the tags.
- **Known limits:** a single Postgres, no retention, the long-transaction delay.

Link it from the README's reliability bullet, replacing the link to the plan.

### 8. Reference as tables
- Split `reference/README.md` into table pages:
  - commands: the `defineCommand` options, with ADR-0010 then linking here
  - views: the `defineView` operations
  - configuration: `Crablet.layer` options and every environment variable, taken from the wallet README paragraph
  - http: endpoints and the mapping from error kind to status
  - metrics: from `monitor-it.md`, which then links here
  - tables
- Its remaining prose goes to the concept pages, and `reference/README.md` becomes the index.

### 9. The Operate track
- New: `configure.md`, profiles that link to the configuration table.
- New: `failure-modes.md`, what happens and what to watch when a leader dies, a network partition hits, connections run out, or a long transaction runs, with the kind-lab results.
- New: `runbooks.md`, what to do when the lag alert fires, when a processor is stuck, and when to pause, resume or reset.
- Link the alerts in `ops/grafana/alerts.yaml` (their annotations) to the runbooks.

### 10. Roadmap
`ROADMAP.md`:
- **Next:** mutation testing, the period follow-ups.
- **Deliberately undecided:** retention, OpenAPI evolution rule B, weeks and time zones, Foldkit server rendering.
- **What 1.0 needs:** npm publishing and the stability policy from ADR-0013.

`docs/history/plans/README.md` links to it for anything open.

### 11. A plain-writing pass
- One idea per sentence.
- Configuration prose becomes links to the tables. The wallet README is the worst case.
- Translate jargon in front-door pages: marker, fence, horizon.
- Add the header line to any page still missing it.
- Set this plan's status.

## Verification
- `bun run typecheck` and `bun run test:unit` after every phase. They include `docs-links`, `guides-sync` (which also covers the README from phase 4), `tutorial-sync`, the OpenAPI tests and the quickstart test.
- Phase 2: the `git grep` above, the `tools/` scripts start, and CI is green on the branch.
- Phase 4: `node examples/quickstart/src/quickstart.ts` prints exactly the lines in the README.
- At the end, the stopwatch walk-through from the newcomer plan, on a fresh clone, done by someone who did not write the docs. Add one check for adopters: from the README, answer "why not just a transaction?", "what is guaranteed?" and "what does it not do?" in under 5 minutes.
