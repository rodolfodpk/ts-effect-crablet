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
| `decide` | yes | | `(state, input, { now, resolved }) => emit(...) \| fail(error) \| noop(reason)`. A pure function. `now` is the instant of this attempt; stamp events with it instead of `new Date()`. `resolved` is what `resolve` looked up. |
| `model` | no | none | `(input, { resolved }) => Model.of({ id })`, or `all({ a: ..., b: ... })` for several. Gives `decide` its state and the command its boundary. Without it, `decide` gets `undefined` and the default consistency is `concurrent()`. |
| `errors` | for each domain error | `[]` | The `DomainError` classes `decide` or `resolve` can fail with. A missing class is a compile error that names it. The HTTP layer documents and maps them. |
| `consistency` | no | `strict()` with a model, `concurrent()` without | `(input, { resolved }) => strict() \| concurrent({ guard })`. `strict()`: anything in the boundary changed since loading refuses the append. `concurrent({ guard })`: safe to run in parallel with itself; only the `guard` events can conflict (deposits). See [the default](#the-default-consistency). |
| `idempotentBy` | for HTTP and automations | none | How a repeat of a request is recognised ([below](#how-a-repeat-is-recognised)): a query, `(input) => Event.where({ ... })`, keyed on something that identifies one **request** (a deposit id, a transfer id); or `"decide"`, when `decide` answers a repeat itself (an id the caller chose: a wallet, a course). Required for a command exposed over HTTP or issued by an automation. |
| `retries` | no | `3` | How many times a `Conflict` re-runs the whole command on fresh state. `0` turns retrying off. |
| `resolve` | no | none | `(input, read) => Effect`. A lookup before the model is chosen, for when the model's id is not in the input (a card number names a member). `read` has `load(model)` and `exists(query)` and no `append`. What it reads joins the command's condition, so a lookup that changes before the append refuses it and the command runs again ([ADR-0029](../adr/0029-a-lookup-cannot-write-and-is-protected.md)). Its result reaches `model`, `consistency` and `decide` as `resolved`. [Guide](../guides/build/look-something-up-first.md). A model with a period is read, not turned: to write into a period, make that model the command's `model`. |

## The default consistency

With a `model` the default is `strict()`; without one it is `concurrent()`. A model can only make a command stricter: without one, `decide` receives
no state, so there is nothing a concurrent run could invalidate. Getting the default wrong therefore costs retries, not data: a command that could run
in parallel with itself (a deposit, a page view) but has a model conflicts with itself under load until it declares `concurrent(...)`. Watch
`crablet.command.conflict_retries` to see it.

What `resolve` read is protected whatever the consistency: it joins a strict command's boundary, a concurrent command's guard (or becomes the guard),
and makes the condition strict when a lookup covers an event the command appends.

## What `decide` returns

| Return | Outcome | Over HTTP |
|---|---|---|
| `emit(event, ...)` | `created`: the events are appended under the consistency condition | `201` with a `marker` |
| `noop(reason)` | `idempotent`: nothing appended; the command was already done, or there was nothing to do | `200`, `status: "IDEMPOTENT"` and the `reason` |
| `fail(new SomeError(...))` | the domain error; nothing appended | the status of the error's `kind` (below) |

A `noop` reason is a short code in `UPPER_SNAKE_CASE` (`ALREADY_SUBSCRIBED`, `ALREADY_OPENED`), the same style as the framework's own: `DUPLICATE_OPERATION` when
`idempotentBy` finds the operation already done, `ALREADY_DONE_FOR_TRIGGER` when an automation's redelivered trigger was recognised by the framework's backstop
rather than by `idempotentBy` ([ADR-0035](../adr/0035-the-same-trigger-cannot-append-the-same-request-twice.md)), and `NO_EVENTS` when `emit()` has no events. A client can switch on it.

An idempotent result carries a marker, the same `lastPosition` and `lastTransactionId` a created one has: where the earlier write is (the latest event the
key matched, or the newest event the decision read). A client whose first answer was lost reads its own write with it. It is null only when there is
nothing to point at (a no-op of a command with no model).

## How a repeat is recognised

A client retries a request whose answer it lost, and an automation's event can be delivered twice. Every command that can be repeated says how it
recognises the repeat, with `idempotentBy` ([ADR-0034](../adr/0034-a-repeat-must-be-the-same-request.md)):

| Form | When | A repeat of the same request | The same key, a different request |
|---|---|---|---|
| a query, `(c) => DepositMade.where({ deposit_id: c.depositId })` | the effect can happen many times (deposits, transfers), so state cannot tell a retry from a new request: the client sends a request id | "already done" (`200`), nothing appended | `IdempotencyMismatch` (`422`): the earlier request stands, this one is not applied |
| `"decide"` | the effect happens once per key (open wallet X, define course Y): the model shows whether it happened | `decide` returns `noop(...)` | `decide` fails with a domain error (`WalletAlreadyExists`, `409`) |

For a query, the framework stores a fingerprint of the request with its events (SHA-256 of the command name and its encoded input) and compares it when the
key matches. The same automation trigger delivered again is always "already done", even if the automation built the input differently the second time.
`"decide"` is a claim the framework cannot check by itself: `assertRepeatHarmless(Command, input, history?)` (`@crablet/commands/testing/Scenario`) runs the
command twice and fails if the repeat appends anything or fails.

## An id that is already taken

When the caller chooses the id of what a command creates, decide it from a model: nothing there, emit; the same request again (the fields sent are the
ones stored), `noop` ("already done", 200); something else under that id, fail with a declared domain error of kind `conflict` (409). The wallet's
`OpenWallet` and the course app's `DefineCourse` do this ([ADR-0027](../adr/0027-a-taken-id-is-decided-not-flagged.md)).

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
| `EventDecodingError` | a stored event in the boundary does not fit its current definition | `500` (logged with the event; never skipped) |

## `defineModel`

From `@crablet/commands/Model`.

| Part | What it does |
|---|---|
| `defineModel({ by, initial })` | A model of one entity, identified by the tag key `by` (`"course_id"`). `initial()` is the state before any event. |
| `.on(Event, (state, data, ctx) => state)` | How one event type changes the state. The handled types also make the boundary. Add `{ by: [...] }` when the event carries the entity under other tag keys (a transfer's `from_account_id` and `to_account_id`). |
| `.ignores(Event, ...)` | Declares event types that carry the model's tags but do not change it, for the change-impact report ([Evolving events](../guides/build/evolving-events.md)). |
| `.period(...)` | Turns the model over by period (`Period.year`, `month`, `week`, `day`, `custom`, with an optional time zone); the framework closes and opens periods in the command's own append ([Turn a period](../guides/build/turn-a-period.md)). |
| `Model.of({ id })` | The model of one entity, used in a command's `model`. |
| `all({ a: ..., b: ... })` | Several models in one decision. The boundary is the union of theirs. |

## `defineEvent`

From `@crablet/commands/Event`. `defineEvent(name, { schema, tags })`: a name, a payload `Schema`, and `tags: (data) => ({ key: value })`, the tags the
event is found by. Mark personal fields with `personal(...)` from `@crablet/commands/Personal`, and keep personal data out of tags
([events over time](../concepts/events-over-time.md#personal-data)).

## Running a command

`CommandExecutor.run(command, input)` validates the input, then in one transaction checks idempotency, runs `resolve`, loads the model, calls
`decide` and appends. It retries on `Conflict`. `CommandExecutor` comes from `Crablet.layer` ([configuration](./configuration.md)).

In tests, `given(...events).when(command, input)` from `@crablet/commands/testing/Scenario` runs the same pipeline on the in-memory store
([Test a command](../guides/build/test-a-command.md)).
