# Dynamic Consistency Boundaries: one decision, two accounts

Most event-sourcing frameworks make you pick an *aggregate* up front: every event belongs to one stream, and
a command may only decide on one stream. "Move money from account A to B" then needs a saga or a
two-phase dance, because the decision reads two streams.

Here there are no streams. There is one log of events, each found by **tags**. A command declares the
events it needs in order to decide - its *boundary* - and the append succeeds only if nothing in that
boundary changed since the command read it. That is the whole idea; the transfer below is the smallest
example where it matters.

## The code

Everything below is `packages/commands/test/support/transfer.ts` (the tests run exactly this).

```ts
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
```

What to notice:

- **`Transferred` carries three tags** (`transfer_id`, `from_account_id`, `to_account_id`). One fact, found
  through either account. The model's `by: [...]` says a transfer belongs to *both*.
- **`all({ from, to })`** is the boundary: the union of both accounts' events. The command says nothing
  about locks or versions; the boundary *is* the declaration.
- **`decide` is pure.** It gets both accounts' state and returns `emit`, `fail` or `noop`. No database.
- **Consistency is strict by default**: if anything in the boundary changed between load and append, the
  append is refused and the whole command is re-run (up to 3 times) with fresh state.
- **`idempotentBy`** makes a repeated `transferId` "already done" instead of a second transfer - and it is
  checked *before* deciding, so a retry after the money has moved does not wrongly fail with
  `InsufficientFunds`.

## What the tests show

No database (`packages/commands/test/transfer-guide.test.ts`, `bun test`):

- a transfer appends one `Transferred` event, findable through both accounts;
- later decisions see earlier transfers on both sides (the receiver can spend what it received);
- overspending and unknown accounts are refused and append nothing;
- a repeated transfer id is "already done" even though the sender is now empty.

Real Postgres (`packages/commands/test/integration/transfer-guide-postgres.test.ts`). Each race uses a barrier so
every racer has *loaded* before any appends - no timing luck:

| Scenario | Result |
|---|---|
| Two transfers of 80 out of an account holding 100 (to different receivers) | Exactly one wins. The loser is retried, re-reads 20, and fails with `InsufficientFunds`. The sender is debited once. |
| Transfers between disjoint accounts (A→B, C→D), retries off | Both succeed: disjoint boundaries never conflict. |
| Two transfers sharing only the receiver (A→B, C→B), retries off | One gets a `Conflict`: the receiver is in both boundaries. |
| The same, with retries (the default) | Both succeed: the loser re-runs on fresh state. Neither is lost. |
| Same `transferId` twice | The second is "already done"; balances are unchanged. |

The third and fourth rows are the point: the boundary is **exactly as wide as the decision** - no wider (disjoint
accounts run in parallel) and no narrower (a shared account is protected).

## When you do not need the boundary to be strict

A command that can safely run in parallel with itself - say a deposit, which only ever adds - can say
`consistency: () => concurrent({ guard })`: concurrent runs do not conflict with each other, and only the
`guard` events (for example "is the account closed?") can still refuse the append. The real wallet example uses
this for deposits; see `examples/wallet-example-app/src/domain/commands/`. The full-size version of the transfer,
with statement periods and lifecycle checks, is `TransferMoneyCommand.ts` there.
