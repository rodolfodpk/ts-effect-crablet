# ts-effect-crablet

![CI](https://github.com/rodolfodpk/ts-effect-crablet/actions/workflows/ci.yml/badge.svg)
[![codecov](https://codecov.io/gh/rodolfodpk/ts-effect-crablet/branch/main/graph/badge.svg)](https://codecov.io/gh/rodolfodpk/ts-effect-crablet)
![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white)
![Effect](https://img.shields.io/badge/Effect-4.0-DE3163)
![Bun](https://img.shields.io/badge/Bun-1.4-000000?logo=bun&logoColor=white)

An event-sourcing framework for TypeScript, built on [Effect](https://effect.website) and PostgreSQL.

It is built around **Dynamic Consistency Boundaries (DCB)**. There are no aggregates and no streams:
events go into one log, each tagged with what it is about, and every command chooses its own
consistency boundary by *querying* the events that matter to its decision. Two commands conflict only
if one changes something the other's decision depended on - so a transfer between two wallets is one
atomic command, not a saga, and unrelated commands never contend.

It is written for teams already using Effect: commands run as `Effect`s with typed errors, and
everything is wired with layers.

> **Status: experimental, pre-release.** The API changes often and makes no stability promise: a breaking change lands
> in one commit that updates every example, test and document ([ADR-0013](./docs/adr/0013-api-evolution-additive-vs-breaking.md)).
> The packages are not published to npm.

**A good fit** when one business rule spans several things (a transfer between two wallets, a course with a seat limit *and* a per-student limit) and you
want it atomic without a saga. **Not a fit** if you are not on PostgreSQL, or want a stable, published library today. Unlike aggregate-based event sourcing, you
do not pick the one stream a command may decide on; the [DCB guide](./docs/dcb-guide.md) shows the difference with a runnable race test.

## Quick start

> New here? [**The tutorial**](./docs/tutorial/course-enrolment.md) builds a small course-enrolment service in five steps - in memory, then Postgres,
> then an HTTP API with a generated OpenAPI description, then read-your-writes, then a Foldkit page that uses it - and every block in it is a tested file.

A command is a pure decision over state derived from events. A seat must be added before it can be booked
(the packages are not published to npm yet; imports come from the workspace, e.g. `@crablet/commands/Command`):

```ts
// 1. Events: their names, their payloads, and the tags they can be found by.
const SeatAdded = defineEvent("SeatAdded", {
  schema: Schema.Struct({ seatId: Schema.String }),
  tags: (d) => ({ seat_id: d.seatId })
});
const SeatBooked = defineEvent("SeatBooked", {
  schema: Schema.Struct({ seatId: Schema.String, guest: Schema.String }),
  tags: (d) => ({ seat_id: d.seatId })
});

// 2. A model: what the events mean for one seat - and, from the same declaration, which events
//    could change that answer (the command's consistency boundary).
const SeatModel = defineModel({ by: "seat_id", initial: () => ({ exists: false, taken: false }) })
  .on(SeatAdded, (seat) => ({ ...seat, exists: true }))
  .on(SeatBooked, (seat) => ({ ...seat, taken: true }));

class SeatNotFound extends DomainError("SeatNotFound", {
  fields: { seatId: Schema.String },
  kind: "not_found"
}) {}
class SeatTaken extends DomainError("SeatTaken", {
  fields: { seatId: Schema.String },
  kind: "conflict"
}) {}

// 3. Commands: pure decisions. Nothing here touches a database.
const AddSeat = defineCommand({
  name: "add_seat",
  errors: [],
  input: Schema.Struct({ seatId: Schema.String }),
  model: (c) => SeatModel.of({ id: c.seatId }),
  decide: (seat, c) => (seat.exists ? noop("already added") : emit(SeatAdded(c)))
});

const BookSeat = defineCommand({
  name: "book_seat",
  errors: [SeatNotFound, SeatTaken],      // the domain errors it can fail with: checked against `decide`, read by the REST API
  input: Schema.Struct({ seatId: Schema.String, guest: Schema.String }),
  model: (c) => SeatModel.of({ id: c.seatId }),
  decide: (seat, c) =>
    !seat.exists
      ? fail(new SeatNotFound({ seatId: c.seatId }))
      : seat.taken
        ? fail(new SeatTaken({ seatId: c.seatId }))
        : emit(SeatBooked(c))
});
```

The boundary is derived from the events the model handles, so `BookSeat` is consistent with "anything that could change this seat" without you
writing a query. Two concurrent bookings of one seat cannot both succeed: the loser is retried and gets `SeatTaken`. Bookings of different seats never
contend. ([The same thing as an Event Model](./docs/event-model-seat-booking.md).)

**Test it without a database** - the real pipeline against an in-memory store that enforces the same rules as Postgres. A scenario is Given/When/Then:

```ts
const scenario = given();                                                       // an empty history
await scenario.when(AddSeat,  { seatId: "12A" });                               // outcome === "created"
const first  = await scenario.when(BookSeat, { seatId: "12A", guest: "Ann" });  // first.outcome === "created"
const second = await scenario.when(BookSeat, { seatId: "12A", guest: "Bob" });  // second.error is a SeatTaken
const third  = await scenario.when(BookSeat, { seatId: "99Z", guest: "Bob" });  // third.error is a SeatNotFound
```

**Run it right now** - the declarations above plus these scenarios are a complete script,
[`examples/quickstart/src/quickstart.ts`](./examples/quickstart/src/quickstart.ts); no database needed:

```bash
bun install
node examples/quickstart/src/quickstart.ts
```

```text
add 12A            -> created: SeatAdded
add 12A again      -> idempotent: nothing appended
book 12A for Ann   -> created: SeatBooked
book 12A for Bob   -> failed: SeatTaken
book 99Z for Bob   -> failed: SeatNotFound
book 12A for Cy, history: SeatAdded + SeatBooked -> failed: SeatTaken
```

You never load events yourself: the executor queries the events in the model's boundary, folds them into the state `decide` receives, and makes the
append conditional on nothing newer having arrived there. The last line seeds the history with `given(...)` to show it.

**Run it** against Postgres with one layer:

```ts
const AppLive = Crablet.layer({ host: "localhost", port: 5432, database: "app", username: "app", password: Redacted.make("secret") });

const program = Effect.gen(function* () {
  const executor = yield* CommandExecutor;
  yield* executor.run(BookSeat, { seatId: "12A", guest: "Ann" });  // validates, runs in a transaction, retries on conflict
});
Effect.runPromise(Effect.provide(program, AppLive));
```

(Tested: [`packages/commands/test/quickstart.test.ts`](./packages/commands/test/quickstart.test.ts) and [`examples/quickstart/test/quickstart.test.ts`](./examples/quickstart/test/quickstart.test.ts).)

## What a command can say

Beyond `model` and `decide`, a command can declare (full list: [ADR-0010](./docs/adr/0010-declarative-command-api.md)):

- `idempotentBy` - a repeat of the same operation is "already done", checked before anything else;
- `consistency: () => concurrent({ guard })` - safe to run in parallel with itself (e.g. deposits); only the `guard` events can conflict;
- `errors: [...]` - the domain errors it can fail with, checked against `decide`. Each carries a `kind` (`not_found`, `invalid`, `conflict`, `forbidden`)
  that the REST API maps to 404/400/409/403 and documents in the generated OpenAPI description, with no per-command HTTP code;
- `retries` (default 3) - a `Conflict` re-runs the command with fresh state.

A rule that spans several things combines models: `all({ from: AccountModel.of({ id: a }), to: AccountModel.of({ id: b }) })` decides on both and
conditions the append on the union of their boundaries ([DCB guide](./docs/dcb-guide.md)).

Events can change shape without rewriting the log: a compatible change (a defaulted or optional field) keeps the name, anything else is a new event.
A stored event that cannot be read is a typed `EventDecodingError` (never skipped, never carrying the payload), and checks keep the models honest:
fixtures, `verifyEvents`, and a change-impact report with a committed baseline ([ADR-0017](./docs/adr/0017-event-evolution-by-compatibility.md),
[guide](./docs/evolving-events.md)).

## Views, the outbox and automations

They are fed by pollers. Guarantees: **no event is skipped** (cursor is a `(transaction_id, position)` pair,
[ADR-0012](./docs/adr/0012-transaction-position-cursors.md)); **at-least-once**, so handlers must be idempotent; delivery is ordered by transaction,
then position, so do not use "position is bigger than the last one I saw" as a general idempotency check; and a long-running transaction anywhere in
the database delays delivery until it ends.

Views update asynchronously. A command answers with a **marker** (where in the log the write ended), and waiting belongs to the read: a read that carries it
(`?consistentWith=<marker>`) is answered only once the views it uses have that write, and a read with no marker waits for everything committed. The default is strict: the
answer is right or a `503`, never stale ([ADR-0015](./docs/adr/0015-read-consistency-by-marker.md)). A client that did not write learns of changes by a ping over server-sent
events ([ADR-0014](./docs/adr/0014-live-updates-by-ping.md)).
Walkthrough: [tutorial step 4](./docs/tutorial/course-enrolment.md).

## HTTP API and OpenAPI

List the commands' **contracts** (`commandContract({ name, input, errors })`) and you get `POST /api/commands/<name>` for each, validated against the
`input` schema, with every failure documented as `application/problem+json`. `GET /openapi.json` serves the generated OpenAPI 3.1 description, checked in at
[`docs/api/wallet-openapi.json`](./docs/api/wallet-openapi.json) so an API change is a visible diff. A browser can import the contracts without receiving
`decide` or the models. Walkthrough: [tutorial step 3](./docs/tutorial/course-enrolment.md); why: [ADR-0011](./docs/adr/0011-http-api-from-the-domain-model.md).

## Operating it

- **Leadership.** Each poller runs on one process at a time, chosen by a session-level advisory lock. The heartbeat checks `pg_locks` for the session, a
  fence runs before the handler and before the cursor moves, and the cursor can only move forward, so a stale leader cannot deliver or rewind.
  A graceful release wakes the others at once; a crash is picked up on the next retry (5 s by default).
- **Storage.** `storageReport()` and `monitorStorage()` (`@crablet/eventstore/Storage`) report the size of the log and its indexes, and `metrics-otel`
  exposes them as `crablet.storage.*` gauges; `examples/wallet-example-app/scripts/report-storage.ts` prints the report. A tag-key table keeps the pollers'
  tag filters cheap (about 1.2 KB per event in all). Nothing deletes events, and retention is not decided ([ADR-0019](./docs/adr/0019-storage-visibility-and-the-tag-table.md)).
- **Evidence.** What was measured, what broke and what was fixed: [`docs/plans/reliability-and-scale-diagnostic.md`](./docs/plans/reliability-and-scale-diagnostic.md).

## Packages

| Package | What it is |
|---|---|
| `packages/db-migrations` | The SQL migrations V1-V12 (event log, command audit, poller progress, conditional append, tag-key table), as a plain file bundle |
| `packages/test-support` | A throwaway Postgres (Testcontainers) for integration tests |
| `packages/eventstore` | The event store: conditional append, tag queries, LISTEN/NOTIFY, leader election, a storage report; plus the spec and an in-memory store for tests |
| `packages/commands` | The authoring API: `defineEvent`, `defineModel`, `defineCommand`, the `CommandExecutor`, `Crablet.layer`, and BDD test helpers |
| `packages/event-poller` | Generic polling engine (progress tracking, backoff, leader-gated fibers) — the shared base the views, outbox, and automations modules build on |
| `packages/views` | Read-model projections: `ViewProjector`s driven by the poller, with subscription and management services |
| `packages/outbox` | Transactional outbox: per-topic publishers fed from the event stream by the poller |
| `packages/automations` | Automations: react to an event by issuing a follow-up command |
| `packages/commands-http` | A REST API over your commands, with RFC 7807 problem-detail errors |
| `packages/views-http` | Consistent reads over views: a read can wait for a write's marker (or the head of the log) before it answers, and is refused with a 503 or marked stale if a view is behind (used by the wallet's and the course app's reads) |
| `packages/metrics-otel` | Metrics (commands, event store, poller, leader, views, outbox, automations, storage) |
| `examples/course-enrolment-app` | The [tutorial](./docs/tutorial/course-enrolment.md)'s small service: two rules decided together, Postgres, HTTP + OpenAPI, one view, reads that wait for a write's marker |
| `examples/quickstart` | The [Quick start](#quick-start) as a script that runs with no database |
| `examples/wallet-example-app` | End-to-end example: wallet commands, views, an automation, an outbox, and HTTP composed together |

## Build & test

Requires Node 24+ (see `.nvmrc`) and Bun 1.4+.

```bash
bun install
bun run typecheck          # tsc --noEmit across the whole workspace
bun run test:unit          # fast tests, no database - runs under Bun
bun run test:unit:coverage # same suite, with an lcov report at coverage/lcov.info
bun run test:integration   # real Postgres via Testcontainers (needs Docker) - runs under Node
```

The in-memory store and Postgres pass the same conformance suite plus a differential test on random histories, so scenarios are a faithful stand-in;
concurrency (races, conflict retry) is tested against Postgres only.

## Learn more

- [`docs/tutorial/course-enrolment.md`](./docs/tutorial/course-enrolment.md) - a tutorial with a runnable example (`examples/course-enrolment-app`).
- [`examples/wallet-example-app`](./examples/wallet-example-app) - a complete application at full size: commands, views, an automation, an outbox and HTTP.
- [`docs/dcb-guide.md`](./docs/dcb-guide.md) - what a dynamic consistency boundary is, through two runnable examples (a transfer between two accounts; course enrolment), with their tests.
- [`docs/evolving-events.md`](./docs/evolving-events.md) - how to change an event without rewriting the log: compatible changes, new events, what happens when one cannot be read, and the checks (fixtures, `verify-events`, the change-impact report).
- [`docs/plans/reliability-and-scale-diagnostic.md`](./docs/plans/reliability-and-scale-diagnostic.md) - the reliability and scale work: what was measured, fixed and dropped (snapshots), and what is left.
- [`docs/adr/`](./docs/adr/README.md) - the lasting design decisions and why they were made. Start with [ADR-0010](./docs/adr/0010-declarative-command-api.md).
- [`NOTES.md`](./NOTES.md) - a running log of findings, gotchas and phase-by-phase status.
