# Evolving events: change an event without rewriting the log

Events are facts. Once written they are never updated, so the log holds **every shape an event has ever been written in**, and the code that reads it
today must still understand all of them. This guide is how to change an event safely, what happens when something cannot be read, and the checks that
tell you before production does. The decision and its reasoning are in [ADR-0017](./adr/0017-event-evolution-by-compatibility.md); every block of code
below is real: it is `packages/commands/test/support/evolving-events.ts`, and the tests run it.

There is a twist that comes from dynamic consistency boundaries ([the DCB guide](./dcb-guide.md)). A model's boundary is built from the event types it
handles, and events are found by **tags**. So two extra things can go wrong when events change: a tag that old events do not carry, and a *new* event
type that carries a model's tags but that the model does not know about. Both are covered below.

## The rule

> A new shape of an event keeps its name only if it can be **built from every older shape**. Anything else is a **new event with a new name**.

| Change | Same event? |
|---|---|
| Add a field with a default | yes |
| Add an optional field | yes |
| Fields the reader does not know are ignored (a newer writer, an older reader) | yes, automatic |
| Rename or remove a field | no: new event |
| Change a field's type or meaning | no: new event |
| Make a field required that old events lack | no: new event |
| Change what a tag means, or remove one | no: new event |

There are no upcasters, no version column and no double-writes. Chains of conversion functions grow with every change; a new name is explicit and
visible in the code.

## Who does what: you decide, the framework detects

Nothing converts an old event for you, and nothing decides whether a change is compatible. Keep the two phases apart:

| | When | Who | What |
|---|---|---|---|
| **Decide** | when you edit the definition | **you** | Is the change compatible with every stored shape? If not, define a new event with a new name. Keep the old definition. Make every model, projector and automation that reads the old event handle the new one (or declare `.ignores(...)`). |
| **Check** | before you deploy | **you, with the tools below** | Keep fixtures of old payloads; run the change-impact report; run `verify-events` on production-like data. The first two run as unit tests; `verify-events` is a script you run (CI does not, because it needs real data). |
| **Detect** | at run time, on every read | **automatic** | A stored event is read through its definition. One that does not fit fails with a typed `EventDecodingError`, and is never skipped. |
| **Repair** | after a detection | **you** | Revert or loosen the definition, or append a new event that corrects the facts ([Corrections are events](#corrections-are-events)). The stored event is never edited. |

So the runtime part is a **safety net, not a feature that handles change**: it turns a silent wrong answer into a loud, typed failure. Whether the change was safe was decided, or missed, at
design time. What *is* automatic and benign: fields the reader does not know are ignored (an older reader with a newer writer), and the defaults and optional fields you declare are
applied when an old event is decoded.

If an incompatible change reaches production under the old name, the effects are the ones in [Reading events](#reading-events-models-projectors-automations) below: commands over that
boundary fail on every attempt, and a view or automation is marked FAILED after `maxErrors`, until you repair it.

## A compatible change: a field with a default

A deposit as first released:

<!-- file: packages/commands/test/support/evolving-events.ts#v1 -->
```ts
// As first released: a deposit has an id and an amount.
export const DepositMadeV1 = defineEvent("DepositMade", {
  schema: Schema.Struct({ depositId: Schema.String, walletId: Schema.String, amount: Schema.Number }),
  tags: (d) => ({ wallet_id: d.walletId, deposit_id: d.depositId })
});
```

Later a fee is added. The events already in the log have no fee:

<!-- file: packages/commands/test/support/evolving-events.ts#v2 -->
```ts
// Later a fee is added. The events already in the log have no fee, so the field gets a DEFAULT, and the event keeps its name.
export const DepositMade = defineEvent("DepositMade", {
  schema: Schema.Struct({
    depositId: Schema.String,
    walletId: Schema.String,
    amount: Schema.Number,
    fee: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0)))
  }),
  tags: (d) => ({ wallet_id: d.walletId, deposit_id: d.depositId })
});
```

What this gives you:

- An old payload decodes with `fee: 0`; a payload written with a fee keeps it. The old definition still reads the new payload and ignores the field.
- The decoded type has `fee` **required**, so code that reads deposits never handles a missing fee. A *new* `DepositMade` must be built with its fee: leaving
  it out is a compile error, because the default exists only for payloads already stored.
- The default applies to an **absent** key only. A `fee: null` or `fee: "2"` is still an error. Use a constant default (`Effect.succeed(...)`): events are
  decoded synchronously.

## A field with no sensible default: make it optional

<!-- file: packages/commands/test/support/evolving-events.ts#optional -->
```ts
// A field with no sensible default is optional instead: an absent key stays absent and nothing is invented. Use this for personal data.
export const WalletOpened = defineEvent("WalletOpened", {
  schema: Schema.Struct({ walletId: Schema.String, owner: personal(Schema.String), nickname: Schema.optionalKey(Schema.String) }),
  tags: (d) => ({ wallet_id: d.walletId })
});
```

An absent key stays absent (`nickname?: string`), so nothing is invented. This is the right choice for **personal data**: a default would put a made-up
value where there was none. `personal(...)` is still found on an optional field, so redaction and the audit still see it.

## An incompatible change: a new event

If the meaning changes, or a required field appears, do not stretch the old event. Name the new fact:

<!-- file: packages/commands/test/support/evolving-events.ts#new-name -->
```ts
// A change that is NOT compatible (a new meaning, a new required field) is a NEW event with a business name, not a "V2" suffix.
export const DepositReversed = defineEvent("DepositReversed", {
  schema: Schema.Struct({ depositId: Schema.String, walletId: Schema.String, amount: Schema.Number, reason: Schema.String }),
  tags: (d) => ({ wallet_id: d.walletId, deposit_id: d.depositId })
});
```

Prefer a business name (`DepositReversed`) to a version suffix (`DepositMadeV2`). The old type **stays defined**, because it stays in the log, and in
every piece of code that reads it.

## Reading events: models, projectors, automations

A model decodes every event it handles through its definition. Anything else that reads events (a view projector, an automation) should do the same, with
`decodeStored`, instead of casting `event.data`, which validates nothing:

<!-- file: packages/commands/test/support/evolving-events.ts#reader -->
```ts
// A reader that is not a model (a view projector, an automation) reads through the definition, never by casting `event.data`.
export const netAmount = (event: StoredEvent) =>
  Effect.gen(function* () {
    // fails with an EventDecodingError (event type, position, transaction, issues) if the payload cannot be read
    const deposit = yield* DepositMade.decodeStored(event);
    return deposit.amount - deposit.fee;
  });
```

When an event **cannot** be read, it is never skipped (a decision made over a partial boundary is worse than a refused one). It fails with a typed
`EventDecodingError` carrying the event's type, position, transaction id and the problems as paths and messages, never the payload value:

- **A command** fails with it, on every later attempt over that boundary, until the data is fixed. Over HTTP it is the generic 500 and the response does not
  say which event; the log line written where it was found does, and so does the counter `crablet.eventstore.decoding_failures` (by event type).
- **A view or an automation** records it against itself like any handler failure, and after `maxErrors` it is marked FAILED, so it is visible, not
  silently wrong. A view batch is one transaction: the good events of the batch are rolled back with the unreadable one.

## Tags are additive-only

Tags are computed from the payload **when the event is written** and stored; they are how a boundary finds the event. If a new tag is computed from a
defaulted field, the old events do not carry it, and a boundary on that tag misses them. So: never remove a tag or give it a new meaning, and a new tag
on a new shape of an old event does not make the old events findable by it. (Rebuilding the tag index from the payloads is possible, since tags are a
pure function of the payload, but it rewrites rows and needs exclusive locks: an exceptional operation, not built here.)

## The checks

| Check | Catches | Needs |
|---|---|---|
| **Fixtures** | an old payload that no longer decodes; a tag derived now that the stored event lacks; a tag that stopped being derived; an event type with no definition | the payloads you kept |
| **`verify-events`** | the same, on the events really stored; event types in the log that no definition accounts for | a database (a copy of production) |
| **The change-impact report** | a model that binds by a tag a new event carries and neither handles nor ignores that event | fixtures (or the log) and your models |

**Fixtures.** Keep a payload for every shape an event was written in, with the tags that were stored with it, and assert the current definition against them.
Add the old shape *before* you change the event: it is what proves the change is compatible. (`fixtureOf(storedEvent)` captures one from an event;
`loadEventFixtures(dir)` reads a directory of JSON, as the wallet and course tests do.)

<!-- file: packages/commands/test/support/evolving-events.ts#fixtures -->
```ts
// The shapes DepositMade has been written in. Add one BEFORE you change the event: it is what proves the change is compatible.
export const depositFixtures: ReadonlyArray<EventFixture> = [
  { type: "DepositMade", payload: { depositId: "d1", walletId: "w1", amount: 10 }, tags: ["wallet_id=w1", "deposit_id=d1"], note: "v1: no fee" },
  { type: "DepositMade", payload: { depositId: "d2", walletId: "w1", amount: 10, fee: 1 }, tags: ["wallet_id=w1", "deposit_id=d2"], note: "v2: with a fee" }
];

export const checkFixtures = () => assertEventFixtures({ definitions: [DepositMade], fixtures: depositFixtures, requireCoverage: true });
```

**`verify-events`.** The fixtures prove the shapes you remembered; this finds the ones you forgot, in the data:

<!-- file: packages/commands/test/support/evolving-events.ts#verify -->
```ts
// Against a copy of production data: do the events that are really stored still decode, and do their tags still match? Read-only; a random sample per type
// by default, `all: true` walks the log.
export const verifyStored = verifyEvents({ definitions: [DepositMade, DepositReversed, WalletOpened], sample: 2_000 });
```

It reports, per event type, how many were checked, how many cannot be read, the first failing positions, what is wrong (most common first), and decodable
events lacking a tag the definition derives now. `examples/wallet-example-app/scripts/verify-events.ts` is a runnable script (`--all`, `--sample`, `--from`,
`--to`, `--type`) that exits 1 on failure: run it in CI against a copy of production before a deploy that changes an event.

## New events and the models that read them

A model that does not handle an event type does not see it in its fold **and its conflict check does not see it either**. When you add `DepositReversed`,
every model bound by `wallet_id` has to decide: does this change my decision? If yes, handle it; if not, say so.

<!-- file: packages/commands/test/support/evolving-events.ts#models -->
```ts
// Both models are bound by wallet_id, so every event that carries wallet_id is something each of them has to account for.
export const WalletBalance = defineModel({ by: "wallet_id", initial: () => ({ exists: false, balance: 0 }) })
  .lifecycle(WalletOpened, () => ({ exists: true, balance: 0 }))
  .on(DepositMade, (w, d) => ({ ...w, balance: w.balance + d.amount - d.fee }))
  .on(DepositReversed, (w, d) => ({ ...w, balance: w.balance - d.amount })); // it changes the balance: handled

export const WalletExists = defineModel({ by: "wallet_id", initial: () => ({ exists: false }) })
  .lifecycle(WalletOpened, () => ({ exists: true }))
  .ignores(DepositMade, DepositReversed); // they carry wallet_id, but do not change whether the wallet exists
```

`.ignores(...)` changes nothing at runtime; it records the intent. The change-impact report reads what each model handles, ignores and binds by, together
with the tag keys each event carries, and reports every pair that is neither:

<!-- file: packages/commands/test/support/evolving-events.ts#impact -->
```ts
// When an event is added, which models bound by one of its tags have not accounted for it? New pairs fail until handled, ignored, or accepted WITH a reason.
export const checkImpact = (baselineFile: string, fixtures: ReadonlyArray<EventFixture>) =>
  assertModelImpact({
    events: eventFactsFromFixtures([DepositMade, DepositReversed, WalletOpened], fixtures),
    models: [modelFactsOf("WalletBalance", WalletBalance.of({ id: "w" })), modelFactsOf("WalletExists", WalletExists.of({ id: "w" }))],
    baselineFile
  });
```

Most findings are "this decision does not care", so the pairs already reviewed live in a committed **baseline** file, each with the **reason** (this is a line of the wallet's, `examples/wallet-example-app/test/fixtures/model-impact-baseline.json`):

```json
{"model":"WalletLifecycleModel","eventType":"WelcomeNotificationSent","reason":"A welcome notification does not change whether the wallet exists."}
```

The check fails on a **new** finding (nobody has looked), on a **stale** entry (it was resolved, and would otherwise regress unnoticed) and on an
**unexplained** one (a blank or token reason). `UPDATE_MODEL_IMPACT_BASELINE=1` rewrites the baseline but keeps the reasons already written and leaves new
pairs blank, so the test still fails until you write why: a refresh is not an approval. Review the diff of that file.

It is a test, not a compiler error; it needs fixtures or a log to know an event's tag keys (an event with no fixture is never reported, so run the
fixtures check with `requireCoverage`); and it checks that a reason *exists*, not that it is right. The wallet and the course app each have one
(`examples/*/test/model-impact.test.ts`).

## Corrections are events

A mistake in the log is corrected by a **compensating event** (`DepositReversed`), never by updating a stored one. The audit trail is the point of the log.

## Checklist: changing an event

1. Capture a payload of the **current** shape into the fixtures (`fixtureOf`), with its tags.
2. Is the change compatible (a field with a default, or an optional one)? Make it. Otherwise define a **new event** with a business name and keep the old
   one defined.
3. Run the fixtures test: it names any old payload that no longer decodes and any tag that drifted.
4. Run the change-impact test: for each model it names, handle the new event (`.on`) or declare it (`.ignores`); accept a pair into the baseline only with a
   real reason.
5. Make sure every reader that is not a model uses `decodeStored`, not a cast.
6. Before deploying, run `verify-events` against a copy of production data.

## What this does not cover

- **Cost at scale.** `verify-events` samples by default (1,000 per type) and `all: true` walks the whole log; neither has been timed on a large log.
- **Subscriptions.** A view or automation that does not subscribe to a new event type shows stale data, the same kind of hole in another place. The
  change-impact report does not look at subscriptions.
- **Personal data and erasure.** Defaults must not invent personal data (use an optional field); crypto-shredding is a separate decision.
- **Judgement.** The tools check that you decided and that the decision is consistent with the data; whether `.ignores` was the *right* decision is a
  review question.
