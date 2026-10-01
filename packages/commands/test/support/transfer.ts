// The DCB guide's example (docs/dcb-guide.md): accounts and a transfer between two of them.
// Shared by the in-memory test (transfer-guide.test.ts) and the Postgres test
// (integration/transfer-guide-postgres.test.ts). The code between the markers is what the guide shows.
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { defineCommand, emit, fail } from "../../src/Command.ts";
import { DomainError } from "../../src/Errors.ts";
import { defineEvent } from "../../src/Event.ts";
import { all, defineModel } from "../../src/Model.ts";
import { afterLoad } from "./barrier.ts";

// ---- START GUIDE ----
// Events. Note there are no streams or aggregates: an event is found by its TAGS.
export const AccountOpened = defineEvent("AccountOpened", {
  schema: Schema.Struct({ accountId: Schema.String, balance: Schema.Number }),
  tags: (d) => ({ account_id: d.accountId })
});
export const Deposited = defineEvent("Deposited", {
  schema: Schema.Struct({ accountId: Schema.String, amount: Schema.Number }),
  tags: (d) => ({ account_id: d.accountId })
});
export const Transferred = defineEvent("Transferred", {
  schema: Schema.Struct({ transferId: Schema.String, from: Schema.String, to: Schema.String, amount: Schema.Number }),
  // ONE event, findable through either account - this is what lets one fact touch two entities.
  tags: (d) => ({ transfer_id: d.transferId, from_account_id: d.from, to_account_id: d.to })
});

// Model of ONE account: its balance, and (from the same declaration) every event that could change it.
export const AccountModel = defineModel({ by: "account_id", initial: () => ({ exists: false, balance: 0 }) })
  .on(AccountOpened, (_, d) => ({ exists: true, balance: d.balance }))
  .on(Deposited, (a, d) => ({ ...a, balance: a.balance + d.amount }))
  .on(Transferred, (a, d, ctx) => ({ ...a, balance: a.balance + (d.to === ctx.id ? d.amount : -d.amount) }), {
    by: ["from_account_id", "to_account_id"] // a transfer belongs to BOTH accounts
  });

export class AccountNotFound extends DomainError("AccountNotFound", {
  fields: { accountId: Schema.String },
  kind: "not_found"
}) {}
export class InsufficientFunds extends DomainError("InsufficientFunds", {
  fields: { accountId: Schema.String, balance: Schema.Number, requested: Schema.Number },
  kind: "conflict"
}) {}

export const transferInput = Schema.Struct({
  transferId: Schema.String,
  from: Schema.String,
  to: Schema.String,
  amount: Schema.Number.check(Schema.isGreaterThan(0))
});

export const Transfer = defineCommand({
  name: "transfer",
  input: transferInput,
  // The decision reads TWO accounts. `all` makes the boundary the union of both accounts' events, so a
  // change to EITHER one after we loaded refuses the append (and the command is re-run).
  model: (c) => all({ from: AccountModel.of({ id: c.from }), to: AccountModel.of({ id: c.to }) }),
  idempotentBy: (c) => Transferred.where({ transfer_id: c.transferId }), // a repeat is "already done"
  decide: ({ from, to }, c) =>
    !from.exists
      ? fail(new AccountNotFound({ accountId: c.from }))
      : !to.exists
        ? fail(new AccountNotFound({ accountId: c.to }))
        : from.balance < c.amount
          ? fail(new InsufficientFunds({ accountId: c.from, balance: from.balance, requested: c.amount }))
          : emit(Transferred(c))
});
// ---- END GUIDE ----

// Test-only variant: the same command, but it waits at a barrier AFTER loading its model, so that several
// runs have all LOADED before any of them appends - a deterministic race instead of timing luck.
export const transferWith = (opts: { wait: Effect.Effect<void>; retries?: number }) =>
  defineCommand({
    name: "transfer_raced",
    input: transferInput,
    model: (c) => afterLoad(all({ from: AccountModel.of({ id: c.from }), to: AccountModel.of({ id: c.to }) }), opts.wait),
    retries: opts.retries ?? 3,
    decide: ({ from, to }, c) =>
      !from.exists || !to.exists
        ? fail(new AccountNotFound({ accountId: from.exists ? c.to : c.from }))
        : from.balance < c.amount
          ? fail(new InsufficientFunds({ accountId: c.from, balance: from.balance, requested: c.amount }))
          : emit(Transferred(c))
  });
