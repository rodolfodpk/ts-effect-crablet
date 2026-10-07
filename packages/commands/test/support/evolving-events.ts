// The code of docs/evolving-events.md. Each `// #region name` ... `// #endregion name` is shown in the guide (a test keeps the two equal), and
// evolving-events-guide.test.ts runs it. Nothing here is special: it is the ordinary API.
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import type { StoredEvent } from "@crablet/eventstore";
import { defineEvent } from "../../src/Event.ts";
import { defineModel } from "../../src/Model.ts";
import { personal } from "../../src/Personal.ts";
import { assertEventFixtures, type EventFixture } from "../../src/testing/EventFixtures.ts";
import { assertModelImpact, eventFactsFromFixtures, modelFactsOf } from "../../src/ModelImpact.ts";
import { verifyEvents } from "../../src/VerifyEvents.ts";

// #region v1
// As first released: a deposit has an id and an amount.
export const DepositMadeV1 = defineEvent("DepositMade", {
  schema: Schema.Struct({ depositId: Schema.String, walletId: Schema.String, amount: Schema.Number }),
  tags: (d) => ({ wallet_id: d.walletId, deposit_id: d.depositId })
});
// #endregion v1

// #region v2
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
// #endregion v2

// #region optional
// A field with no sensible default is optional instead: an absent key stays absent and nothing is invented. Use this for personal data.
export const WalletOpened = defineEvent("WalletOpened", {
  schema: Schema.Struct({ walletId: Schema.String, owner: personal(Schema.String), nickname: Schema.optionalKey(Schema.String) }),
  tags: (d) => ({ wallet_id: d.walletId })
});
// #endregion optional

// #region new-name
// A change that is NOT compatible (a new meaning, a new required field) is a NEW event with a business name, not a "V2" suffix.
export const DepositReversed = defineEvent("DepositReversed", {
  schema: Schema.Struct({ depositId: Schema.String, walletId: Schema.String, amount: Schema.Number, reason: Schema.String }),
  tags: (d) => ({ wallet_id: d.walletId, deposit_id: d.depositId })
});
// #endregion new-name

// #region reader
// A reader that is not a model (a view projector, an automation) reads through the definition, never by casting `event.data`.
export const netAmount = (event: StoredEvent) =>
  Effect.gen(function* () {
    // fails with an EventDecodingError (event type, position, transaction, issues) if the payload cannot be read
    const deposit = yield* DepositMade.decodeStored(event);
    return deposit.amount - deposit.fee;
  });
// #endregion reader

// #region fixtures
// The shapes DepositMade has been written in. Add one BEFORE you change the event: it is what proves the change is compatible.
export const depositFixtures: ReadonlyArray<EventFixture> = [
  { type: "DepositMade", payload: { depositId: "d1", walletId: "w1", amount: 10 }, tags: ["wallet_id=w1", "deposit_id=d1"], note: "v1: no fee" },
  { type: "DepositMade", payload: { depositId: "d2", walletId: "w1", amount: 10, fee: 1 }, tags: ["wallet_id=w1", "deposit_id=d2"], note: "v2: with a fee" }
];

export const checkFixtures = () => assertEventFixtures({ definitions: [DepositMade], fixtures: depositFixtures, requireCoverage: true });
// #endregion fixtures

// #region models
// Both models are bound by wallet_id, so every event that carries wallet_id is something each of them has to account for.
export const WalletBalance = defineModel({ by: "wallet_id", initial: () => ({ exists: false, balance: 0 }) })
  .lifecycle(WalletOpened, () => ({ exists: true, balance: 0 }))
  .on(DepositMade, (w, d) => ({ ...w, balance: w.balance + d.amount - d.fee }))
  .on(DepositReversed, (w, d) => ({ ...w, balance: w.balance - d.amount })); // it changes the balance: handled

export const WalletExists = defineModel({ by: "wallet_id", initial: () => ({ exists: false }) })
  .lifecycle(WalletOpened, () => ({ exists: true }))
  .ignores(DepositMade, DepositReversed); // they carry wallet_id, but do not change whether the wallet exists
// #endregion models

// #region impact
// When an event is added, which models bound by one of its tags have not accounted for it? New pairs fail until handled, ignored, or accepted WITH a reason.
export const checkImpact = (baselineFile: string, fixtures: ReadonlyArray<EventFixture>) =>
  assertModelImpact({
    events: eventFactsFromFixtures([DepositMade, DepositReversed, WalletOpened], fixtures),
    models: [modelFactsOf("WalletBalance", WalletBalance.of({ id: "w" })), modelFactsOf("WalletExists", WalletExists.of({ id: "w" }))],
    baselineFile
  });
// #endregion impact

// #region verify
// Against a copy of production data: do the events that are really stored still decode, and do their tags still match? Read-only; a random sample per type
// by default, `all: true` walks the log.
export const verifyStored = verifyEvents({ definitions: [DepositMade, DepositReversed, WalletOpened], sample: 2_000 });
// #endregion verify
