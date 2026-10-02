# ts-effect-crablet

![CI](https://github.com/rodolfodpk/ts-effect-crablet/actions/workflows/ci.yml/badge.svg)
[![codecov](https://codecov.io/gh/rodolfodpk/ts-effect-crablet/branch/main/graph/badge.svg)](https://codecov.io/gh/rodolfodpk/ts-effect-crablet)
![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white)
![Effect](https://img.shields.io/badge/Effect-4.0%20RC-DE3163)
![Bun](https://img.shields.io/badge/Bun-1.4-000000?logo=bun&logoColor=white)

An event-sourcing framework for TypeScript, built on [Effect](https://effect.website) and PostgreSQL.

It is built around **Dynamic Consistency Boundaries (DCB)**. There are no aggregates and no streams:
events go into one log, each tagged with what it is about, and every command chooses its own
consistency boundary by *querying* the events that matter to its decision. Two commands conflict only
if one changes something the other's decision depended on - so a transfer between two wallets is one
atomic command, not a saga, and unrelated commands never contend.

It is written for teams already using Effect: commands run as `Effect`s with typed errors, and
everything is wired with layers.

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

The model's boundary is derived from the events it handles, so `BookSeat` is consistent with respect to
"anything that could change this seat" without you writing a query. Two concurrent bookings of one seat
cannot both succeed; the loser is retried and gets `SeatTaken`. Bookings of different seats never
contend.

**As an [Event Model](https://eventmodeling.org/)** - time runs left to right; the same declarations, seen as the blueprint:

```text
 Screen     ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        ┌─────────┐
            │ Add seat│ │Book seat│ │Book seat│ │Book seat│ │  Seat   │        │  Seat   │
            │  (12A)  │ │(12A,Ann)│ │(12A,Bob)│ │(99Z,Bob)│ │   map   │        │   map   │
            └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └─────────┘        └─────────┘
                 │           │           │           │           ▲                  ▲
 ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─
                 ▼           ▼           ▼           ▼           │                  │
 Command    ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐      │                  │
            │ AddSeat │ │BookSeat │ │BookSeat │ │BookSeat │      │                  │
            └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘      │                  │
   SeatModel    exists:no   exists:yes  exists:yes  exists:no     │                  │
   at decide    taken:no    taken:no    taken:yes   taken:no      │                  │
 ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─
                 ▼           ▼           ▼           ▼           │                  │
 Event log  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐      │                  │
            │SeatAdded│▶│SeatBook-│ │SeatTaken│ │SeatNot- │      │                  │
            │seat=12A │ │ed 12A   │ │ rejected│ │Found    │      │                  │
            └────┬────┘ └────┬────┘ │  (409)  │ │rejected │      │                  │
                 │           │      └─────────┘ │  (404)  │      │                  │
                 │           │       (errors write no event)     │                  │
 ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─
                 ▼           ▼                                   │                  │
 Read model ┌──────────────────────────────────────────────────────────────────────────┐
            │ AvailableSeats:   12A listed  ──────▶  12A removed      (updated async) │
            └──────────────────────────────────────────────────────────────────────────┘
```

The read model is not part of this quick start (it needs the poller; the [tutorial](./docs/tutorial/course-enrolment.md)
builds one). The Given/When/Then of a scenario is the same picture: *given* `SeatAdded(12A)` and `SeatBooked(12A)`,
*when* `BookSeat(12A, Cy)`, *then* `SeatTaken`.

**Test it without a database** - the real pipeline (validation, idempotency, load, decide, conditional
append) against an in-memory store that enforces the same rules as Postgres:

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

You never load events yourself: when a command runs, the executor queries the events in the model's boundary
(`SeatAdded` and `SeatBooked` tagged `seat_id=12A`), folds them through the model's `.on` handlers into the state
`decide` receives, and makes the append conditional on nothing newer having arrived in that boundary. The last line
seeds the history with `given(SeatAdded(...), SeatBooked(...))` to show it. `AddSeat` is idempotent: adding a seat
that exists is a `noop`, so nothing is appended.

**Run it** against Postgres with one layer:

```ts
const AppLive = Crablet.layer({ host: "localhost", port: 5432, database: "app", username: "app", password: Redacted.make("secret") });

const program = Effect.gen(function* () {
  const executor = yield* CommandExecutor;
  yield* executor.run(BookSeat, { seatId: "12A", guest: "Ann" });  // validates, runs in a transaction, retries on conflict
});
Effect.runPromise(Effect.provide(program, AppLive));
```

(The code above is tested: see [`packages/commands/test/quickstart.test.ts`](./packages/commands/test/quickstart.test.ts), and the script's output by [`examples/quickstart/test/quickstart.test.ts`](./examples/quickstart/test/quickstart.test.ts).)

## What a command can say

| You write | You get |
|---|---|
| `model: (c) => SeatModel.of({ id: c.seatId })` | State for `decide`, and the boundary the append is protected by |
| *(nothing)* | `strict()`: the append fails with `Conflict` if anything in the boundary changed since it was loaded |
| `consistency: () => concurrent({ guard })` | Safe to run in parallel with itself (e.g. deposits); only the `guard` events (e.g. "is the wallet closed?") can conflict |
| `idempotentBy: (c) => Event.where({ op_id: c.opId })` | A repeat of the same operation is "already done", checked before anything else - so a retry never re-decides against state the first attempt already changed |
| `onDuplicate: "fail"` | ...or a repeat fails with `Duplicate` (e.g. "open a wallet that already exists") |
| `prepare: (c, eventStore) => ...` | An effectful pre-step (look something up, open a statement); its result feeds `model` and `decide`; rolled back with the command |
| `retries: 3` (default) | A `Conflict` re-runs the whole command with fresh state; `0` turns it off |
| `fail(new MyDomainError(...))` | A typed failure. The command's error type is inferred from every `fail(...)` in `decide` |
| `errors: [MyDomainError]` | The domain errors the command can fail with, declared once. `decide` (and `prepare`) cannot fail with a domain error that is not listed: the compile error names the missing class |

Errors declared with `DomainError(tag, { fields, kind })` carry a neutral `kind` (`not_found`,
`invalid`, `conflict`, `forbidden`). The REST API (`packages/commands-http`) reads a command's `errors`: it maps each
kind to 404/400/409/403, presents the error's own fields in the response, and documents them in the generated OpenAPI
description - with no per-command HTTP code. It will not let you expose a command whose errors it cannot present.

## What views, the outbox and automations can rely on

They are fed by pollers with these guarantees:

- **No event is skipped.** A poller's cursor is a `(transaction_id, position)` pair, so an event that commits late with a lower
  position than one already delivered is still delivered ([ADR-0012](./docs/adr/0012-transaction-position-cursors.md)).
- **At-least-once.** A handler can see an event again (after a crash, or a reset), so it must be idempotent.
- **Delivery order is by transaction, then position.** Events of unrelated transactions are not necessarily delivered in position
  order, so do not use "position is bigger than the last one I saw" as a general idempotency check. It is safe only where the events
  that touch one row are written one after another, as in the tutorial's seats view (commands that share a boundary are serialized).
  Use the event's identity (as the wallet views do) when in doubt.
- **A long-running transaction anywhere in the database delays delivery** until it ends (events are only read once their transaction
  has finished), so alert on idle-in-transaction sessions.

## Reading your own writes

Views are updated asynchronously, a moment after the command that caused the change. When a caller needs to see its
own write (an HTTP response that shows the new balance), wait for the view to catch up to the command's position:

```ts
const result = yield* executor.run(Deposit, input);            // result.lastPosition / lastTransactionId: where its events ended
yield* waitUntilProcessed(walletBalanceViewSubscription, { transactionId: result.lastTransactionId!, position: result.lastPosition! });   // @crablet/views/WaitUntilProcessed
// ... one read of the view now includes the deposit
```

`lastPosition` (and `lastTransactionId`) is `null` for an idempotent repeat (nothing was appended), which returns at once. The wait fails with
`WaitTimeout` if the view does not catch up in time and with `ViewFailed` if the view is marked FAILED.

Over HTTP it is a query parameter: `POST /api/commands/deposit?waitFor=wallet-balance-view` answers once that view has
the write, so the caller's next read is not stale. The app lists which views can be waited for (`viewWaiters` in
`CommandApiConfig`, an entry per view; `commands-http` does not depend on the views package) and those names appear in
the API description. The response always carries `lastPosition` (a string) and, when asked, `view: { name, caughtUp }`.
A view that did not catch up in time (`timeout`), is `view_failed`, or could not be read (`unavailable`) is reported there
- never as an error status, because the command itself succeeded and retrying it would be wrong. An unknown `waitFor`
or a bad `waitTimeout` (1-30000 ms, default 5000) is a 400 before the command runs.

## HTTP API and OpenAPI

Declare the API from the commands' **contracts** (a command's public part: `commandContract({ name, input, errors })`; the behavior is added by spreading it into `defineCommand`) and the API gets a route for each, `POST /api/commands/<name>`, with no HTTP code:

- the request body is the command's own `input` schema, validated before the command runs;
- every failure it can have is documented and presented: the framework's own (bad payload 400, stale decision 409) and the domain
  errors it declares in `errors: [...]` (status from the error's `kind`, body typed with the error's own fields,
  `application/problem+json`);
- `GET /openapi.json` serves the generated OpenAPI 3.1 description (an optional Scalar or Swagger page with `docs: { ui }`); the
  wallet's is checked in at [`docs/api/wallet-openapi.json`](./docs/api/wallet-openapi.json), regenerated by `bun run docs:api`, and
  a unit test fails when it is stale - so an API change is a visible diff in review;
- `?waitFor=<view>` waits for a view before responding (see above).

Write inputs with `Schema.Finite` / `Schema.Int` and `Schema.optionalKey` so their constraints reach the description (a lint reports
`Schema.Number` and `Schema.optional`). Clients: run any OpenAPI generator on `/openapi.json`, or derive one from the API itself with
`HttpApiClient.make(makeWalletApi(), { baseUrl })` (no codegen; typed per command: the payload is checked at compile time and each
command fails with exactly the problems it declares). Because the API is declared from contracts only, a browser can import the API definition
without receiving `decide`, the models or the events. Why it is shaped this way: [ADR-0011](./docs/adr/0011-http-api-from-the-domain-model.md).

## Packages

| Package | What it is |
|---|---|
| `packages/db-migrations` | The SQL migrations (event log, command audit, poller progress, conditional append), as a plain file bundle |
| `packages/test-support` | A throwaway Postgres (Testcontainers) for integration tests |
| `packages/eventstore` | The event store: conditional append, tag queries, LISTEN/NOTIFY, leader election; plus the spec and an in-memory store for tests |
| `packages/commands` | The authoring API: `defineEvent`, `defineModel`, `defineCommand`, the `CommandExecutor`, `Crablet.layer`, and BDD test helpers |
| `packages/event-poller` | Generic polling engine (progress tracking, backoff, leader-gated fibers) — the shared base the views, outbox, and automations modules build on |
| `packages/views` | Read-model projections: `ViewProjector`s driven by the poller, with subscription and management services |
| `packages/outbox` | Transactional outbox: per-topic publishers fed from the event stream by the poller |
| `packages/automations` | Automations: react to an event by issuing a follow-up command |
| `packages/commands-http` | A REST API over your commands, with RFC 7807 problem-detail errors |
| `packages/metrics-otel` | Metrics (commands, event store, poller, leader, views, outbox, automations) |
| `examples/course-enrolment-app` | The [tutorial](./docs/tutorial/course-enrolment.md)'s small service: two rules decided together, Postgres, HTTP + OpenAPI, one view with `?waitFor=` |
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

A conformance suite runs the same cases against the in-memory store (unit tests) and against Postgres
(integration tests), and a differential test feeds both stores identical random histories and requires
identical results - so the in-memory store is a faithful stand-in for testing decision logic.
Concurrency (races, conflict retry) is tested against Postgres only.

The coverage badge only covers the fast Bun unit suite, not the Postgres-backed integration tests.

## Learn more

- [`docs/tutorial/course-enrolment.md`](./docs/tutorial/course-enrolment.md) - a 30-minute tutorial with a runnable example (`examples/course-enrolment-app`).
- [`examples/wallet-example-app`](./examples/wallet-example-app) - a complete application at full size: commands, views, an automation, an outbox and HTTP.
- [`docs/dcb-guide.md`](./docs/dcb-guide.md) - what a dynamic consistency boundary is, through two runnable examples (a transfer between two accounts; course enrolment), with their tests.
- [`docs/adr/`](./docs/adr/README.md) - the lasting design decisions and why they were made. Start with [ADR-0010](./docs/adr/0010-declarative-command-api.md).
- [`NOTES.md`](./NOTES.md) - a running log of findings, gotchas and phase-by-phase status.
