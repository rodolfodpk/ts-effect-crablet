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

A command is a pure decision over state derived from events. Three declarations (the packages are not
published to npm yet; imports come from the workspace, e.g. `@crablet/commands/Command`):

```ts
// 1. An event: its name, its payload, and the tags it can be found by.
const SeatBooked = defineEvent("SeatBooked", {
  schema: Schema.Struct({ seatId: Schema.String, guest: Schema.String }),
  tags: (d) => ({ seat_id: d.seatId })
});

// 2. A model: what the events mean for one seat - and, from the same declaration, which events
//    could change that answer (the command's consistency boundary).
const SeatModel = defineModel({ by: "seat_id", initial: () => ({ taken: false }) })
  .on(SeatBooked, () => ({ taken: true }));

class SeatTaken extends DomainError("SeatTaken", {
  fields: { seatId: Schema.String },
  kind: "conflict"
}) {}

// 3. A command: a pure decision. Nothing here touches a database.
const BookSeat = defineCommand({
  name: "book_seat",
  errors: [SeatTaken],      // the domain errors it can fail with: checked against `decide`, read by the REST API
  input: Schema.Struct({ seatId: Schema.String, guest: Schema.String }),
  model: (c) => SeatModel.of({ id: c.seatId }),
  decide: (seat, c) => (seat.taken ? fail(new SeatTaken({ seatId: c.seatId })) : emit(SeatBooked(c)))
});
```

The model's boundary is derived from the events it handles, so `BookSeat` is consistent with respect to
"anything that could change this seat" without you writing a query. Two concurrent bookings of one seat
cannot both succeed; the loser is retried and gets `SeatTaken`. Bookings of different seats never
contend.

**Test it without a database** - the real pipeline (validation, idempotency, load, decide, conditional
append) against an in-memory store that enforces the same rules as Postgres:

```ts
const scenario = given();                                                       // an empty history
const first  = await scenario.when(BookSeat, { seatId: "12A", guest: "Ann" });  // first.outcome === "created"
const second = await scenario.when(BookSeat, { seatId: "12A", guest: "Bob" });  // second.error is a SeatTaken
```

**Run it** against Postgres with one layer:

```ts
const AppLive = Crablet.layer({ host: "localhost", port: 5432, database: "app", username: "app", password: Redacted.make("secret") });

const program = Effect.gen(function* () {
  const executor = yield* CommandExecutor;
  yield* executor.run(BookSeat, { seatId: "12A", guest: "Ann" });  // validates, runs in a transaction, retries on conflict
});
Effect.runPromise(Effect.provide(program, AppLive));
```

(The code above is tested: see [`packages/commands/test/quickstart.test.ts`](./packages/commands/test/quickstart.test.ts).)

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

## Reading your own writes

Views are updated asynchronously, a moment after the command that caused the change. When a caller needs to see its
own write (an HTTP response that shows the new balance), wait for the view to catch up to the command's position:

```ts
const result = yield* executor.run(Deposit, input);            // result.lastPosition: where its events ended
yield* waitUntilProcessed(walletBalanceViewSubscription, result.lastPosition);   // @crablet/views/WaitUntilProcessed
// ... one read of the view now includes the deposit
```

`lastPosition` is `null` for an idempotent repeat (nothing was appended), which returns at once. The wait fails with
`WaitTimeout` if the view does not catch up in time and with `ViewFailed` if the view is marked FAILED.

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

- [`examples/wallet-example-app`](./examples/wallet-example-app) - a complete application: commands, views, an automation, an outbox and HTTP.
- [`docs/dcb-guide.md`](./docs/dcb-guide.md) - what a dynamic consistency boundary is, through two runnable examples (a transfer between two accounts; course enrolment), with their tests.
- [`docs/adr/`](./docs/adr/README.md) - the lasting design decisions and why they were made. Start with [ADR-0010](./docs/adr/0010-declarative-command-api.md).
- [`NOTES.md`](./NOTES.md) - a running log of findings, gotchas and phase-by-phase status.
