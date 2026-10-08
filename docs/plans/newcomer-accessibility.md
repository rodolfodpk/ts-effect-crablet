# Plan: make the repository accessible to a newcomer

## Goal

A developer who has never seen the project should, without asking anyone:

1. understand in **two minutes** what it is, what it is good at and whether it fits (README);
2. run something in **ten minutes** (quickstart);
3. build something real in **an hour** (tutorial), and know where to go next for each question (a map, not a pile).

Success is judged by walking the path as a newcomer would (see "How we will know").

## What a newcomer meets today (measured, 2026-10-07)

| Place | State | Problem for a newcomer |
|---|---|---|
| `README.md` | 118 lines, idea, strengths, one example, a "Where next" table | Good. The example takes 55 lines before the first run command |
| `docs/` | 4 guides at the top level, `reference.md`, `tutorial/`, `adr/` (19), `plans/` (7), `api/` | Guides, decision records and internal plans sit side by side with no index; nothing says which to read first |
| `docs/tutorial/course-enrolment.md` | 833 lines, 5 steps in one file | A long scroll; no way to stop after step 2 and know you have something; steps are not separate pages |
| `NOTES.md` | 1,422 lines, the working journal, linked from the README | Reads as the project's front door but is a diary; it holds the "why" of many things and is mixed with gotchas |
| `docs/plans/` | Seven plans, some finished, one superseded in part | Look like a roadmap; they are records |
| `docs/adr/` | 19 ADRs, one flat list, in order of writing | The first ones (0001-0009) are runtime internals; a newcomer needs 0010 and 0011 first; the list does not group |
| Packages | 11 packages, no README in any | Opening `packages/views` explains nothing; the package table is only in `docs/reference.md` |
| Examples | 4 (`quickstart`, `course-enrolment-app`, `course-enrolment-ui`, `wallet-example-app`) | The order to read them in is only in the README table; none has a README |
| Vocabulary | DCB, boundary, tag, marker, horizon, cursor, fence, projector, outbox | Defined in passing, in different places; no glossary |
| Contributing / running | Build commands are in `docs/reference.md#build--test` | No `CONTRIBUTING.md`; nothing on how to run one test, regenerate the OpenAPI file, or run the diagnostics |

## Principles

- **One front door, one path.** The README answers "what is it, is it for me, how do I start"; everything else is reached from a map.
- **Teach in layers.** Concept (why) -> tutorial (do) -> guides (a task) -> reference (look up) -> decisions (why it is so). Each document says which layer it is and links to its neighbours.
- **Keep the code tested.** Anything shown as code comes from a tested file (as the tutorial and `evolving-events.md` already do); moving documents must not break the sync tests.
- **Records are not guides.** Plans and the journal are kept, labelled as history, and not linked from the front door.
- **Do not rewrite for its own sake.** Move and index first; rewrite only where a newcomer would be lost.

## The steps

Ordered by value for a newcomer per unit of work. Each is its own commit.

### 1. A docs index and a reading order (small, highest value)

`docs/README.md`: the map of every document, grouped by layer, with one line each and a suggested path ("new: README -> quickstart -> tutorial steps 1-2 -> DCB guide").

- Groups: **Start** (quickstart, tutorial), **Understand** (DCB guide, event-model-seat-booking, glossary), **Do** (evolving events, and later the other task guides), **Look up** (reference, OpenAPI file), **Decisions** (ADR index), **History** (plans, NOTES).
- The README's "Where next" table points here and keeps only its top four rows.

Done when: every file under `docs/` is reachable from `docs/README.md` in one click, and there is a link check for it.

### 2. A glossary (small)

`docs/glossary.md`: about 25 terms in plain words, each with one sentence and one link: event, tag, query, model, boundary, consistency (append) condition, command, decision, marker, cursor, projector, view, outbox, automation, poller, leader, fence, horizon, `all(...)`, idempotency, at-least-once. Link each term to where it is taught.

Done when: the README, the tutorial and the DCB guide link a term's first use to the glossary.

### 3. Split the tutorial into pages (medium) - DONE (2026-10-07)

Decision: one file per step. Built: `docs/tutorial/README.md` (index, prerequisites, "If something fails"), `01`-`05` step pages each ending with "You now have..." and previous/next links, `where-next.md`, and a stub at the old path. `tutorial-sync.test.ts` now reads every page. Step 5 is about 290 lines (a whole page, with its own sections), above the 220 target; the others are 104-171.

`docs/tutorial/` becomes a folder with `README.md` (what you will build, prerequisites, time per step) and `01-the-rule-in-memory.md` ... `05-a-page-that-uses-it.md`, each ending with "you now have..." and a link to the next. The step files keep their code blocks tested; the sync tests that read the old file are updated in the same commit.

- Add "Before you start" (Node 24, Bun, Docker only from step 2) and "If something fails" (the usual: Docker not running, port in use).
- Each step states what it adds and which parts you can skip.

Done when: no step file exceeds about 220 lines; the old URL still resolves (a stub that links to the new index); `bun run test:unit` passes.

### 4. A README in each package and example (medium, mostly mechanical)

Each gets 15-30 lines: what it is for, the one example of use, its public entry points (the `exports` of its `package.json`), what it depends on, where its decision records are. Generated skeleton from `package.json`, written by hand after.

- `examples/*/README.md`: what it demonstrates, how to run it, which tutorial step it belongs to.
- `docs/reference.md`'s package table links to these.

Done when: every directory under `packages/` and `examples/` has a README and no link is broken.

### 5. Group and label the decision records (small)

`docs/adr/README.md` regrouped under headings: **Start here** (0010, 0011, 0015, 0017), **Runtime internals** (0001-0009, 0012, 0016), **Data and storage** (0003, 0012, 0019), **Evolution** (0013, 0017, 0018 superseded). One line of "what you learn" per record. Records themselves unchanged.

Done when: a newcomer can find the "start here" four without reading the others.

### 6. Label history, and make the journal findable (small)

- `docs/plans/README.md`: each plan with its status (done, done in part, superseded) and the date, and a sentence saying these are records, not a roadmap.
- `NOTES.md`: move to `docs/journal.md` is **not** proposed (many links; no gain). Instead add a table of contents at its head and a one-paragraph note that it is the working log. The README links it last.

Done when: no plan reads as open work unless it is.

### 7. Task guides for what people ask first (medium, optional order)

Short "how do I..." pages, each from tested code: add a view; add an automation; add an HTTP endpoint for a command; run against Postgres in production (migrations, pool, the poller layers); monitor it (the storage gauges, the leader gauges); test a command. Most content exists, spread over the tutorial, the wallet app and the reference; the work is to gather it and link it from `docs/README.md`.

Done when: the six questions have a page of one screen with a link to the code that proves it.

### 8. CONTRIBUTING and a developer page (small)

`CONTRIBUTING.md`: set up, run one test file, run unit and integration, regenerate `docs/api/wallet-openapi.json` (`bun run docs:api`), run a diagnostic (and that they are outside CI), the commit and decision-record conventions (the ADR process, when a change needs one).

Done when: a contributor can run one integration test from the page alone.

### 9. Consistency pass (small, last)

Same heading style, "you" voice, no unexplained abbreviation on first use, the same example domain where possible (seat booking in README and quickstart; course enrolment in tutorial; wallet in the full app), a link check and a spelling pass added to CI if cheap.

## Order and size

| Step | What | Size | Needs a decision |
|---|---|---|---|
| 1 | Docs index | 0.25 day | no |
| 2 | Glossary | 0.5 day | no |
| 5 | ADR grouping | 0.25 day | no |
| 6 | Label plans, journal contents | 0.25 day | no |
| 3 | Split the tutorial | 1 day | yes (below) |
| 4 | Package and example READMEs | 1 day | no |
| 8 | CONTRIBUTING | 0.25 day | no |
| 7 | Task guides | 2 days | which to write first |
| 9 | Consistency pass | 0.5 day | no |

Steps 1, 2, 5, 6 can ship together as the first pass (about 1 day) and already change what a newcomer sees.

## Decisions for the owner

1. **Tutorial split (step 3):** one file per step (recommended: each page is a stopping point and a link target) or keep one long file and add a table of contents at its head (cheaper; still a long scroll).
2. **Docs site:** keep plain markdown on GitHub (recommended for a pre-release project; no build to maintain) or add a generated site later. This plan assumes markdown only.
3. **Task guides (step 7):** which two first? Suggested: "add a view" and "monitor it".
4. **Plans folder:** keep in `docs/plans/` with a status README (recommended) or move finished ones to `docs/history/`.

## Risks

- **Moving the tutorial breaks tested links.** The sync tests and the example folders read the tutorial's code; step 3 updates them in the same commit and leaves a stub at the old path.
- **Documents drift from the code.** More documents mean more drift. Mitigation: code in documents comes from tested files, and a link check runs in CI (step 1).
- **Over-explaining for a pre-release API.** The API changes often (ADR-0013). Guides state what is tested, not what is hoped; the status note stays prominent.

## How we will know

Walk the path with a fresh clone and a stopwatch, as a newcomer, and write down where we stopped:

1. From the README alone, say what the project is for and what it is not for (target: under 2 minutes).
2. Run the quickstart (target: under 10 minutes, no Docker).
3. Finish tutorial step 2 (Postgres) (target: under 45 minutes).
4. Answer three questions using only `docs/README.md`: where is the delivery guarantee described, which decision record explains the cursor, how do I add a view.

Any step that takes more than twice its target is a documentation bug, and goes back into this plan.
