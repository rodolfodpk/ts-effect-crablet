# ts-effect-crablet

![CI](https://github.com/rodolfodpk/ts-effect-crablet/actions/workflows/ci.yml/badge.svg)
[![codecov](https://codecov.io/gh/rodolfodpk/ts-effect-crablet/branch/main/graph/badge.svg)](https://codecov.io/gh/rodolfodpk/ts-effect-crablet)
![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white)
![Effect](https://img.shields.io/badge/Effect-4.0-DE3163)
![Bun](https://img.shields.io/badge/Bun-1.4-000000?logo=bun&logoColor=white)

Event sourcing for TypeScript with **Dynamic Consistency Boundaries**, built on [Effect](https://effect.website) and PostgreSQL.

There are no aggregates and no streams. Events go into one log, each tagged with what it is about, and every command chooses its own consistency
boundary by *querying* the events its decision depends on. Two commands conflict only if one changes something the other relied on.

## Why

- **Atomic across things, without a saga.** A transfer between two wallets, or a course with a seat limit *and* a per-student limit, is one command
  ([DCB guide](./docs/dcb-guide.md), with a runnable race test).
- **No contention between unrelated commands.** The boundary is derived from the events a model handles; you never write the query or pick a stream.
- **Decisions are pure and testable without a database.** Given/When/Then scenarios run the real pipeline on an in-memory store that passes the same
  conformance suite as Postgres.
- **Typed end to end.** Domain errors are declared and checked against `decide`; the REST API and its OpenAPI description are generated from the contracts.
- **Reads you can trust.** A command returns a marker; a read carrying it waits until the views have that write, or answers `503`, never stale.
- **Built to be operated.** Fenced leader election, no skipped events, event evolution checks and storage metrics, each measured
  ([reliability report](./docs/plans/reliability-and-scale-diagnostic.md)).

> **Status: experimental, pre-release.** The API changes often, packages are not published to npm
> ([ADR-0013](./docs/adr/0013-api-evolution-additive-vs-breaking.md)). Not a fit if you are not on PostgreSQL or need a stable library today.

## A command in 30 lines

A seat must be added before it can be booked. Imports come from the workspace, e.g. `@crablet/commands/Command`.

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

`BookSeat` is consistent with "anything that could change this seat" without a query written by you. Two concurrent bookings of one seat cannot both
succeed: the loser is retried and gets `SeatTaken`; other seats never contend.

**Run it, no database needed** ([`examples/quickstart`](./examples/quickstart/src/quickstart.ts)):

```bash
bun install
node examples/quickstart/src/quickstart.ts
```

**Against Postgres**, one layer:

```ts
const AppLive = Crablet.layer({ host: "localhost", port: 5432, database: "app", username: "app", password: Redacted.make("secret") });
const program = Effect.gen(function* () {
  yield* (yield* CommandExecutor).run(BookSeat, { seatId: "12A", guest: "Ann" });  // validates, runs in a transaction, retries on conflict
});
Effect.runPromise(Effect.provide(program, AppLive));
```

## Where next

| You want to | Read |
|---|---|
| Find anything | [Documentation map](./docs/README.md), and the [glossary](./docs/glossary.md) for any unfamiliar word |
| Build something, step by step | [Tutorial](./docs/tutorial/README.md): in memory, Postgres, HTTP + OpenAPI, read-your-writes, a UI |
| Understand the idea | [DCB guide](./docs/dcb-guide.md) |
| See a full application | [`examples/wallet-example-app`](./examples/wallet-example-app) |
| Change an event safely | [Evolving events](./docs/evolving-events.md) |
| Look up options, packages, guarantees, operations, build and test | [Reference](./docs/reference.md) |
| Know why it is built this way | [Design decisions](./docs/adr/README.md) (start with [ADR-0010](./docs/adr/0010-declarative-command-api.md)) |
| Follow the work log | [`NOTES.md`](./NOTES.md) |

Build and test: `bun install`, `bun run typecheck`, `bun run test:unit`, `bun run test:integration` (Docker). Details in the [reference](./docs/reference.md#build--test).
