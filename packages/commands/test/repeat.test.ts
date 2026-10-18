// A repeat must be the same request (ADR-0034): what `idempotentBy` decides about a key that was already used, and what a repeat answers with. Runs on
// the in-memory event store; the Postgres store gives the same verdicts (packages/commands/test/integration/repeat-postgres.test.ts).
import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import * as Schema from "effect/Schema";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import * as CorrelationContext from "@crablet/eventstore/CorrelationContext";
import { makeInMemoryEventStore } from "@crablet/eventstore/testing/InMemoryEventStore";
import { defineCommand, emit, fail, noop } from "../src/Command.ts";
import { runHandler } from "../src/CommandExecutor.ts";
import { IdempotencyMismatch } from "../src/Errors.ts";
import { defineEvent } from "../src/Event.ts";
import { defineModel } from "../src/Model.ts";
import { assertRepeatHarmless, given } from "../src/testing/Scenario.ts";

const Paid = defineEvent("RP_Paid", { schema: Schema.Struct({ accountId: Schema.String, paymentId: Schema.String, amount: Schema.Number }), tags: (d) => ({ account_id: d.accountId, payment_id: d.paymentId }) });
const Opened = defineEvent("RP_Opened", { schema: Schema.Struct({ accountId: Schema.String }), tags: (d) => ({ account_id: d.accountId }) });
const Account = defineModel({ by: "account_id", initial: () => ({ open: false, paid: 0 }) })
  .lifecycle(Opened, (s) => ({ ...s, open: true }))
  .on(Paid, (s, d) => ({ ...s, paid: s.paid + d.amount }));

const payInput = Schema.Struct({ accountId: Schema.String, paymentId: Schema.String, amount: Schema.Number });
// A payment can happen many times: the client's payment id tells a retry from a new payment.
const Pay = defineCommand({
  name: "rp_pay",
  input: payInput,
  idempotentBy: (c) => Paid.where({ payment_id: c.paymentId }),
  model: (c) => Account.of({ id: c.accountId }),
  decide: (_, c) => emit(Paid(c))
});
// An account opens once: the model shows whether it did, and decide answers a repeat.
const Open = defineCommand({
  name: "rp_open",
  input: Schema.Struct({ accountId: Schema.String }),
  idempotentBy: "decide",
  model: (c) => Account.of({ id: c.accountId }),
  decide: (account, c) => (account.open ? noop("ALREADY_OPEN") : emit(Opened(c)))
});

describe("a repeat of the same request", () => {
  test("a query key: the repeat is already done, appends nothing", async () => {
    const s = given();
    expect((await s.when(Pay, { accountId: "a", paymentId: "p1", amount: 10 })).outcome).toBe("created");
    const again = await s.when(Pay, { accountId: "a", paymentId: "p1", amount: 10 });
    expect(again.outcome).toBe("idempotent");
    expect(again.reason).toBe("DUPLICATE_OPERATION");
    expect(again.events).toEqual([]);
  });

  test("the repeat answers with the EARLIER write's marker (a query key, and a decide answer), so a client whose first answer was lost can read its write", async () => {
    const store = makeInMemoryEventStore();
    const run = <A>(e: Effect.Effect<A, unknown, any>) => Effect.runPromise(Effect.provide(e, store.layer) as Effect.Effect<A>);
    const first = await run(runHandler(Pay.handler, { accountId: "a", paymentId: "p1", amount: 10 }));
    const again = await run(runHandler(Pay.handler, { accountId: "a", paymentId: "p1", amount: 10 }));
    expect([again.lastPosition, again.lastTransactionId]).toEqual([first.lastPosition, first.lastTransactionId]);

    const opened = await run(runHandler(Open.handler, { accountId: "b" }));
    const reopened = await run(runHandler(Open.handler, { accountId: "b" }));
    expect(reopened.wasIdempotent).toBe(true);
    expect([reopened.lastPosition, reopened.lastTransactionId]).toEqual([opened.lastPosition, opened.lastTransactionId]);
  });
});

describe("the same key from a different request", () => {
  test("is refused with IdempotencyMismatch, and the earlier request stands", async () => {
    const s = given();
    await s.when(Pay, { accountId: "a", paymentId: "p1", amount: 10 });
    const other = await s.when(Pay, { accountId: "a", paymentId: "p1", amount: 20 });
    expect(other.outcome).toBe("failed");
    expect(other.error).toBeInstanceOf(IdempotencyMismatch);
    expect((other.error as IdempotencyMismatch).message).not.toContain("20"); // it never echoes the input
    expect(s.log.filter((e) => e.type === "RP_Paid").map((e) => (e.data as { amount: number }).amount)).toEqual([10]);
  });

  test("an event appended before fingerprints existed (none stored) matches as before: already done", async () => {
    const s = given(Paid({ accountId: "a", paymentId: "p1", amount: 10 })); // seeded: no request fingerprint
    expect((await s.when(Pay, { accountId: "a", paymentId: "p1", amount: 20 })).outcome).toBe("idempotent");
  });

  test("the same trigger delivered again is already done even if the input was rebuilt differently (an automation's redelivery)", async () => {
    const store = makeInMemoryEventStore();
    const underTrigger = <A>(e: Effect.Effect<A, unknown, any>, trigger: bigint) =>
      Effect.runPromiseExit(Effect.provide(CorrelationContext.withCausationId(trigger)(e), store.layer) as Effect.Effect<A>);
    expect(Exit.isSuccess(await underTrigger(runHandler(Pay.handler, { accountId: "a", paymentId: "p1", amount: 10 }), 7n))).toBe(true);
    // Redelivered: state changed in between, so the automation built another amount; the trigger's work is done.
    const redelivered = await underTrigger(runHandler(Pay.handler, { accountId: "a", paymentId: "p1", amount: 11 }), 7n);
    expect(Exit.isSuccess(redelivered) && redelivered.value.wasIdempotent).toBe(true);
    // Another trigger reusing the key with another request: the key is too broad, and that is refused.
    const otherTrigger = await underTrigger(runHandler(Pay.handler, { accountId: "a", paymentId: "p1", amount: 12 }), 8n);
    expect(Exit.isFailure(otherTrigger)).toBe(true);
  });

  test("the fingerprint is the ENCODED input: the same value is the same request whatever the key order", async () => {
    const s = given();
    await s.when(Pay, { accountId: "a", paymentId: "p1", amount: 10 });
    expect((await s.when(Pay, { amount: 10, paymentId: "p1", accountId: "a" })).outcome).toBe("idempotent");
  });
});

describe("assertRepeatHarmless", () => {
  test("passes for a query key and for a decide answer", async () => {
    await assertRepeatHarmless(Pay, { accountId: "a", paymentId: "p1", amount: 10 });
    await assertRepeatHarmless(Open, { accountId: "b" });
  });

  test("fails for a \"decide\" claim that decide does not keep: the repeat appends again", async () => {
    const Counted = defineCommand({ name: "rp_counted", input: Schema.Struct({ accountId: Schema.String }), idempotentBy: "decide", decide: (_, c) => emit(Opened(c)) });
    await expect(assertRepeatHarmless(Counted, { accountId: "c" })).rejects.toThrow(/NOT HARMLESS/);
  });

  test("fails for a repeat answered with an error: a client retrying a lost answer would be told it failed", async () => {
    class AlreadyOpen extends Error {}
    const Strict = defineCommand({
      name: "rp_strict",
      input: Schema.Struct({ accountId: Schema.String }),
      idempotentBy: "decide",
      model: (c) => Account.of({ id: c.accountId }),
      decide: (account, c) => (account.open ? fail(new AlreadyOpen("open")) : emit(Opened(c)))
    });
    await expect(assertRepeatHarmless(Strict, { accountId: "d" })).rejects.toThrow(/the repeat of a request that succeeded failed/);
  });

  test("fails for a command that does not say how a repeat is recognised", async () => {
    const Bare = defineCommand({ name: "rp_bare", input: Schema.Struct({ accountId: Schema.String }), decide: (_, c) => emit(Opened(c)) });
    await expect(assertRepeatHarmless(Bare, { accountId: "e" })).rejects.toThrow(/does not say how a repeat is recognised/);
  });

  test("tells the author when the first run did not append", async () => {
    await expect(assertRepeatHarmless(Open, { accountId: "f" }, [AppendEvent.ofUntagged("Nothing", {}), Opened({ accountId: "f" })])).rejects.toThrow(/the first run must append/);
  });
});
