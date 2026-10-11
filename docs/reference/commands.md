# Commands and models

*Reference · developers writing commands · the [tutorial](../tutorial/README.md) step 1 · look up*

What `defineEvent`, `defineModel` and `defineCommand` accept, and what a command can answer. The ideas behind them are in
[consistency boundaries](../concepts/dcb-guide.md); the decision is [ADR-0010](../adr/0010-declarative-command-api.md).

## `defineCommand` options

From `@crablet/commands/Command`.

| Option | Required | Default | What it does |
|---|---|---|---|
| `name` | yes | | The command's name, 1 to 64 characters. Also its HTTP path: `POST /api/commands/<name>`. |
| `input` | yes | | The `Schema` the input is validated against. Every failing field is reported, not just the first. |
| `decide` | yes | | `(state, input, prepared, { now }) => emit(...) \| fail(error) \| noop(reason)`. A pure function. `now` is the instant of this attempt; stamp events with it instead of `new Date()`. |
| `model` | no | none | `(input, prepared) => Model.of({ id })`, or `all({ a: ..., b: ... })` for several. Gives `decide` its state and the command its boundary. Without it, `decide` gets `undefined` and the default consistency is `concurrent()`. |
| `errors` | for each domain error | `[]` | The `DomainError` classes `decide` or `prepare` can fail with. A missing class is a compile error that names it. The HTTP layer documents and maps them. |
| `consistency` | no | `strict()` | `strict()`: anything in the boundary changed since loading refuses the append. `concurrent({ guard })`: safe to run in parallel with itself; only the `guard` events can conflict (deposits). |
| `idempotentBy` | no | none | `(input) => Event.where({ ... })`. If a matching event exists, the command is "already done". Checked before `decide`, and again at the append. Required for a command an automation issues. |
| `onDuplicate` | no | `"return"` | What a repeat answers: `"return"` reports success, `"fail"` fails with `Duplicate` (for example "open a wallet that already exists"). |
| `retries` | no | `3` | How many times a `Conflict` re-runs the whole command on fresh state. `0` turns retrying off. |
| `prepare` | no | none | `(input, eventStore) => Effect`. An effectful step inside the command's transaction, before the model is loaded. Give any append in it a condition. Do not use it to turn a period; declare `.period` on the model. |

## What `decide` returns

| Return | Outcome | Over HTTP |
|---|---|---|
| `emit(event, ...)` | `created`: the events are appended under the consistency condition | `201` with a `marker` |
| `noop(reason)` | `idempotent`: nothing appended | `200` |
| `fail(new SomeError(...))` | the domain error; nothing appended | the status of the error's `kind` (below) |

## Domain error kinds

A `DomainError` declares a `kind`, which decides its HTTP status. It is documented in the generated OpenAPI description, with no per-command status code.

| `kind` | Status |
|---|---|
| `not_found` | `404` |
| `invalid` | `400` |
| `conflict` | `409` |
| `forbidden` | `403` |

## Framework errors

| Error | When | Over HTTP |
|---|---|---|
| `InvalidInput` | the input does not match the schema; lists every failing field | `400` |
| `Conflict` | the boundary changed, and the retries ran out | `409` |
| `Duplicate` | a repeat, with `onDuplicate: "fail"` | `409` |
| `EventDecodingError` | a stored event in the boundary does not fit its current definition | `500` (logged with the event; never skipped) |

## `defineModel`

From `@crablet/commands/Model`.

| Part | What it does |
|---|---|
| `defineModel({ by, initial })` | A model of one entity, identified by the tag key `by` (`"course_id"`). `initial()` is the state before any event. |
| `.on(Event, (state, data, ctx) => state)` | How one event type changes the state. The handled types also make the boundary. Add `{ by: [...] }` when the event carries the entity under other tag keys (a transfer's `from_account_id` and `to_account_id`). |
| `.ignores(Event, ...)` | Declares event types that carry the model's tags but do not change it, for the change-impact report ([Evolving events](../guides/build/evolving-events.md)). |
| `.period(...)` | Turns the model over by period (month, day, year, custom); the framework closes and opens periods in the command's own append ([Turn a period](../guides/build/turn-a-period.md)). |
| `Model.of({ id })` | The model of one entity, used in a command's `model`. |
| `all({ a: ..., b: ... })` | Several models in one decision. The boundary is the union of theirs. |

## `defineEvent`

From `@crablet/commands/Event`. `defineEvent(name, { schema, tags })`: a name, a payload `Schema`, and `tags: (data) => ({ key: value })`, the tags the
event is found by. Mark personal fields with `personal(...)` from `@crablet/commands/Personal`, and keep personal data out of tags
([events over time](../concepts/events-over-time.md#personal-data)).

## Running a command

`CommandExecutor.run(command, input)` validates the input, then in one transaction checks idempotency, runs `prepare`, loads the model, calls
`decide` and appends. It retries on `Conflict`. `CommandExecutor` comes from `Crablet.layer` ([configuration](./configuration.md)).

In tests, `given(...events).when(command, input)` from `@crablet/commands/testing/Scenario` runs the same pipeline on the in-memory store
([Test a command](../guides/build/test-a-command.md)).
