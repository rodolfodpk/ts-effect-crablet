# Plan: read consistency by marker (ADR-0015)

## Context
[ADR-0015](../adr/0015-read-consistency-by-marker.md) moves "wait for the views" off the command request (`?waitFor=<view>`) and onto the read (`?consistentWith=<marker>|latest`). The command returns a `marker` and waits for nothing; a new package, `@crablet/views-http`, wraps each read endpoint: it parses the marker, resolves a server policy (`strict` / `bounded` / `eventual`, a default, a client override within bounds), waits for every view the endpoint reads, and answers `503` or marks the response stale on a timeout.

Under ADR-0013 the removal of `?waitFor` is a breaking change that must update every consumer in one commit. So the plan builds the new path **beside** the old one (phases 1-5, each additive and green), then removes the old path in a single breaking commit (phase 6). The ADR stays "Proposed" until phase 6 flips it to "Accepted".

## What is where today (checked)
- The command response (`CommandApi.ts`) has `lastPosition` and `lastTransactionId`, plus an optional `view` member that exists only for `?waitFor`. `makeCommandApi` takes `waitableViews`; `CommandApiConfig` takes `viewWaiters`; `ViewWaiter.ts` defines the contract.
- `waitUntilProcessed(subscription, write, { timeout, interval })` already compares `(transaction_id, position)` pairs and has the "nothing relevant pending" shortcut. It needs a **subscription**, not a view name.
- Reads are hand-written `HttpApi` groups in the example apps: `CourseQueryApiLive` (`getCourse`, `listCourses`, keyset pagination, `limit` and `after` validated by the handler as plain strings) and `WalletQueryApiLive` (`getWallet`, `getWalletTransactions` with `page`/`size` and `OFFSET`, `getWalletSummary`). `courseSeatsViewSubscription` and `walletViewSubscriptions` already exist.
- `commands-http` depends on `commands` and `eventstore`; `views` depends on `eventstore`, `event-poller`, `metrics-otel` and has no HTTP dependency. `commands-http` has no 503 or `Retry-After` problem yet.
- The tutorial blocks are tested files (`tutorial-sync.test.ts`), so tutorial step 4 cannot be edited in prose alone.
- The course app has a `viewDelayMs` knob that holds each view batch back, which the stale-read integration test already uses (`course-view-delay.test.ts`).

## The phases at a glance
Day estimates are mine, not measured.

| | Phase | Value | Cost | Depends on | Commit |
|---|---|---|---|---|---|
| 0 | Wallet transactions list to keyset pagination | fixes a real repeat/skip bug whatever happens to the rest | 0.5 day | - | alone, breaking for that one endpoint |
| 1 | `marker` in the command response, plus the marker codec | the token every later phase uses | 0.5 day | - | additive |
| 2 | Spike: response header and `503` + `Retry-After` through `HttpApi` | decides how `bounded` and `strict` are expressed | 0.25 day | - | none (findings go in the ADR) |
| 3 | `@crablet/views-http`: policy, head-of-log, concurrent wait, problems, schema fragments, wrapper | the feature | 2.5 days | 1, 2 | additive |
| 4 | Wrap the example apps' reads; regenerate OpenAPI | proves it on two real apps | 1 day | 3 | additive |
| 5 | Course UI sends the marker on its next read | the first real client | 1 day | 4 | additive |
| 6 | Remove `?waitFor` everywhere; amend ADR-0011; rewrite tutorial step 4; ADR-0015 to Accepted | closes the migration | 1.5 days | 5 | one breaking commit |
| 7 | Measure `latest` at read rates and the poll cost; add to the scale envelope | confirms the cost claims | 0.5 day | 4 | none or a small tweak |

About 7.75 days. Phases 3 and 6 are the ones most likely to run over: 3 is six modules with unit and integration tests, and 6 touches about 25 files of code, tests and docs, plus a tested tutorial. Each phase ends green (`bun run typecheck`, `bun run test:unit`, and the integration suites **run in batches of a few files**, see NOTES.md) and is committed on its own; push only on request.

## Phase 0. Wallet transactions list to keyset pagination
**Why first.** `getWalletTransactions` uses `ORDER BY occurred_at DESC LIMIT size OFFSET page*size`. A transaction arriving between two page requests moves a row onto both pages or off both. That is true today and independent of this work, but consistency makes it visible: a client now reads fresh data and still gets a torn listing.
**Change.** `limit` (default 20, cap 100, validated by the handler like the course list) and `after` (an opaque cursor); read `limit + 1` rows to know whether `next` exists; the response becomes `{ transactions, next }`.
**The cursor key.** The view's primary key is `(transaction_id, event_position)`, and a transfer writes two rows for one event (`{transferId}-from` and `-to`, same `event_position`). So `transaction_id` alone is not unique and `(occurred_at, transaction_id)` is not a safe tiebreaker across wallets or event types. Use `(occurred_at, event_position, transaction_id)`, which is unique per row. (This `transaction_id` is the wallet view's own text id, not the log's xid.)
**The index.** The existing index is `(wallet_id, occurred_at DESC)`, which does not cover the tiebreaker. Add `V104__wallet_transaction_view_page_index.sql` with `(wallet_id, occurred_at DESC, event_position DESC, transaction_id DESC)` and check the plan with `EXPLAIN` on a few thousand rows.
**Tests.** A concurrency test: page through a wallet while a writer appends, assert no repeat and no skip.
**Breaking.** `page` and `size` go away; nothing in the repository consumes them besides the tests and the checked-in OpenAPI.

## Phase 1. The marker
- `marker` (string `"<transactionId>:<position>"`) on `CommandCreatedResponse`; `null` on the idempotent response for now. Additive (ADR-0013).
- **Where the codec lives.** `commands-http` produces markers and `views-http` parses them, and `commands-http` cannot import `event-poller`. Put `formatMarker` and `parseMarker` in a small new module of `@crablet/eventstore` (both packages already depend on it). Parsing rejects anything that is not two non-negative integers.
- **The idempotent marker (open item in the ADR).** Spike first: does the idempotency check expose the matching event's position and transaction? If it does, return that marker, which fixes a retry after a lost response. If it does not, record that and leave `null`.
- **Tests.** Codec round trip and rejection cases (unit); the response carries the marker (integration); regenerate `docs/api/*.json` (additive diff).

## Phase 2. Spike: what `HttpApi` lets us do
Two questions, answered before the package is built:
1. Can a typed success response set a header (`Crablet-Consistency: stale`)? Commands already use `handleRaw` with `HttpServerResponse`, so the raw path is a known fallback; the question is whether the OpenAPI description still documents the success body and the header.
2. Can a declared problem carry `Retry-After`, and can one endpoint declare both its domain 404 and the 503?
**Output.** A paragraph in ADR-0015 with the answer and the chosen mechanism. If neither works cleanly, `bounded` signals staleness with a field in the body envelope instead of a header, and the ADR says so.

## Phase 3. `@crablet/views-http`
New workspace package (picked up by `packages/*`, `tsconfig.json` and the test globs automatically; run `bun install` to link it). Depends on `views`, `event-poller`, `eventstore` and `effect`, and imports `commands-http/ProblemDetail` so reads and writes share one problem format.

| Module | Job |
|---|---|
| `ReadConsistency` | The config type and the **pure** policy resolver: request, then endpoint, then API default; `clientMayRelax`; timeout clamped to `maxTimeout`; `whenNoMarker`. No Effect, fully unit-tested. |
| `HeadOfLog` | `SELECT transaction_id::text, position::text FROM crablet_events ORDER BY transaction_id DESC, position DESC LIMIT 1`, using the existing `(transaction_id, position)` index. An empty log yields the zero cursor, which returns at once. Also used to reject a marker beyond the head with a `400`. |
| `WaitForViews` | Runs `waitUntilProcessed` for every subscription concurrently under one shared deadline and collects **every** outcome (it must not fail on the first), so the problem can list each lagging view and how far it got. |
| `ReadProblems` | `ViewsNotCaughtUp` (503, `Retry-After`, `views: [{ name, reached }]`) and `ViewFailed` (503, no `Retry-After`). |
| `ReadQuery` | Schema fragments to spread into an endpoint: `consistentWith`, `consistency`, `waitTimeout` as plain strings (validated by the wrapper, like `limit`, so a bad value gets the same problem body as every other 400). |
| `withReadConsistency` | The wrapper: validate parameters (400, before any wait), resolve the policy, wait, then run the handler, or answer `503`, or mark stale. |

**Order inside the wrapper.** Validate everything first, so a bad `limit` never waits. Then: no marker and `whenNoMarker: "none"` runs the handler; `latest` (or no marker with `whenNoMarker: "latest"`) reads the head of the log once; a given marker is parsed and checked against the head. Then the wait, then the mode decides.
**`reads` as a list of subscriptions, or a function of the request.**
**Metrics** (small, in `metrics-otel`): a counter of reads by `{mode, outcome: caught_up | stale | timeout | view_failed | skipped}`, and a histogram of wait time. These are the signals that show the poller stall to readers.
**Tests.**
- Unit (Bun): the policy matrix (every combination of default, endpoint, request, `clientMayRelax`, clamping); marker and `latest` handling with a fake head; the wait with fake subscriptions (all caught up, one lagging, one `FAILED`, timeout, shared deadline).
- Integration (Node, real Postgres): a wrapped endpoint over a view held back by a delay: `strict` returns 503 then succeeds on retry; `bounded` returns the stale marker; `eventual` returns at once; a marker beyond the head is a 400; a read of **three** views waits for all three; `latest` with a long-open transaction times out under `strict` and returns under `eventual`. To make the stall, the test holds a second connection open with `BEGIN; SELECT pg_current_xact_id();` (the xid is assigned at the first such call), writes events from another connection, and checks the view cannot pass them until the first connection ends. Also pin what `latest` does **not** cover: a transaction still open when the request arrives is not part of "the head as of the request", so its events may be missing from the response.

## Phase 4. Wrap the example apps' reads
- **Course.** `getCourse` and `listCourses` read `[courseSeatsViewSubscription]`. Keep `parseLimit` and the other validation in the handler; the wrapper validates its own parameters first.
- **Wallet.** `getWallet` reads the balance view, `getWalletTransactions` the transaction view, `getWalletSummary` the summary view (subscriptions from `walletViewSubscriptions`).
- **A multi-view endpoint.** The wallet has no read that spans views, so add `GET /api/wallets/:walletId/overview` (balance, last transactions, summary) only if the multi-view integration test needs a real route; otherwise the wrapper's own test covers it and the example stays smaller. Decide when phase 3 is done.
- App-level config sets the policy (`strict`, `whenNoMarker: "latest"`, 5 s, cap 30 s, `clientMayRelax: false`) once per app.
- **Each endpoint's `error` becomes a union.** `getCourse` declares only the domain 404 (`problemSchemaOf(CourseNotFound)`) and `getWalletSummary` and its siblings only `WalletNotFoundProblem`; none declares a 400 or a 503. Once the wrapper can answer both, every wrapped endpoint must declare them (domain 404, 400, 503), or the generated description and the derived client are wrong. `listCourses` already declares `BadRequestProblem`.
- Regenerate both OpenAPI documents (additive: new query parameters and a new 503). They have separate generators: `bun run docs:api` at the repo root writes the wallet document, and `bun run docs:api` inside `examples/course-enrolment-app` (it runs under Node) writes the course one. Update the OpenAPI tests.
- The old `?waitFor` still works in this phase.

## Phase 5. The Foldkit page
`defineCourseCall` currently passes `waitForView`; the derived client already types the API definition, so the new query parameters appear in it. Change the page so a write keeps the returned `marker` and the page's next `getCourse` or `listCourses` sends `consistentWith=<marker>`; the "wait for the seat map" toggle becomes "read with my marker" (default on), so the demo still shows the stale read and the fix. The live feed and its debounce are untouched. Update `page.test.ts`, `api-base-url.test.ts` if affected, and `page-against-server.test.ts`.

## Phase 6. The breaking commit
Remove, in one commit, with "breaking" in the message (ADR-0013):
- `commands-http`: `ViewWaiter.ts` (and its entry in `package.json`, which also matched), `viewWaiters` in `CommandApiConfig`, `waitableViews`, `waitQuery`, `ViewWaitResult` and the `view` member in `CommandApi.ts`, the wait branch in `CommandApiLive.ts`, and the tests that mention them (`command-api-description.test.ts`, `contract-api.types.ts`, `command-api-integration.test.ts`).
- Course app: `courseViewWaiters` in `CourseApp.ts`, `ViewWaitResult` and the waiter comment in `CourseApi.ts`, the `waitFor` comment in `CourseQueryApi.ts`, `index.ts`, and the tests (`course-http`, `course-list`, `course-feed`, `course-view-delay`, `course-openapi`). Wallet app: `walletViewWaiters` in `WalletApp.ts` and `lifecycle-e2e`.
- Course UI: `api.ts` (it imports `ViewWaitResult` from the course app and builds `queryOf(waitForView)`), `main.ts`, and both page tests.
- Docs: tutorial step 4 rewritten around write, marker, read, with the tested blocks kept in sync (`tutorial-sync.test.ts`); README lines on `?waitFor`; ADR-0011 amended; ADR-0012 and ADR-0014 references updated; a NOTES entry; the plans that mention `waitFor` get a one-line pointer here, not a rewrite.
- Regenerate `docs/api/*.json`. ADR-0015 status becomes **Accepted**; the README index is already updated.

## Phase 7. Measure
A small load run against the course app: reads per second with `latest` against a baseline with no wait, at the scale envelope's read rates; the pool cost of N concurrent waiters polling every 25 ms; behavior while a long transaction is open. If the head query shows up, add the short in-process cache of the head the ADR mentions; if the poll cost shows up, that is the cue to move the wait onto the shared per-instance listener (a separate piece of work).

## Risks
- **`HttpApi` limits** on headers and multiple declared errors (phase 2) could change how `bounded` is expressed. The spike comes before the package so this is cheap to learn.
- **`latest` ties reads to the poller's stall.** Any long transaction makes strict reads fail. That is intended, and the metrics and the scale envelope say so, but expect operational surprises the first time; the tests include the stall.
- **Hand-written read groups.** The wrapper cannot force an endpoint to declare `reads` correctly; a view left out of `reads` silently reads stale. Mitigate with one test per endpoint that writes, then reads with the marker.
- **Tutorial and OpenAPI churn** in phase 6: byte-for-byte comparisons of `docs/api/*.json` and the tutorial sync test fail loudly if anything is missed.
- **The idempotent marker** may not be recoverable from the idempotency check; phase 1 settles it.
- **A new package** adds to the workspace and the CI install; confirm `bun install` and `.github/workflows/ci.yml` need nothing else.

## Not in this plan
The SSE feed and its per-page `LISTEN` connection (ADR-0014), moving the wait from polling to a shared listener, the connection-limit work from the scale envelope, event versioning and snapshots, and the leader fencing from the architecture review.
