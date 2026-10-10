# Turn a period

Some state is kept **per period**: a wallet's statement for a month, a till's shift, a ledger page. When the first command of a new period arrives, the old period must be closed and the new one opened with the
state carried forward ("closing the books"). Declare the period once on the model and the framework turns it **inside the command's own append**, under the command's own condition: the turn and the command's
events are written together or not at all, two commands racing to turn it cannot both do it, and a command that decided in a period that has closed since conflicts and runs again in the new one.

[← Task guides](README.md)

## Declare the period on the model

The model is the same fold you already write; `.period(...)` adds what turns it. `opened` must already have a handler (`.on(opened, ...)`) that folds what `open` carries forward (an opening balance, say).

<!-- file: examples/wallet-example-app/src/domain/WalletModel.ts#period-model -->
```ts
export const WalletPeriodModel = walletFold.period(Period.month, {
  opened: WalletStatementOpened,
  closed: WalletStatementClosed,
  open: (carry, p) => ({
    walletId: p.id,
    statementId: statementIdOf(p.id, p.key),
    ...p.fields,
    openingBalance: carry.balance,
    openedAt: p.at
  }),
  close: (state, p) => ({
    walletId: p.id,
    statementId: statementIdOf(p.id, p.key),
    ...p.fields,
    openingBalance: state.balance,
    closingBalance: state.balance,
    closedAt: p.at
  })
});
```

- `Period.month` is a value, not a string: it carries the type of its fields (`{ year, month }`) and the framework derives from it the period "now" falls in, the tags that scope the model, a canonical key (`"2026-10"`) and
  which period an opening event opened. Levels today: `Period.year`, `Period.month`, `Period.day` (UTC). `Period.custom({ fieldsAt, fieldsOf, key, tagKeys })` is the way to a fiscal year or a shift.
- `open(carry, p)` builds the opening event from the state the old period ended with; `close(state, p)` builds the closing event. `p` is `{ id, key, fields, at }`. Keep both **total**: they also run for an entity
  that does not exist yet (the command then refuses, and the turn is dropped).
- Both events need the model's binding tag (`wallet_id`) and the tags of the level (`year`, `month`): without them a period's query would never find its own opening, and every command would open it again. The
  framework checks this the first time it turns a period and names the missing tag.

## Write the command without a `prepare`

The model is built from the id alone; the state `decide` receives carries `period: { key, fields, tags }`. Put `period.tags` on the events the command appends, and stamp them with `now`: it is the instant the period
was decided at, so a timestamp and a period agree, also under a test clock.

<!-- file: examples/wallet-example-app/src/domain/commands/DepositCommand.ts#period-command -->
```ts
export const Deposit = defineCommand({
  ...DepositContract,
  model: (c) => WalletPeriodModel.of({ id: c.walletId }),
  consistency: (c) => concurrent({ guard: WalletPeriodModel.lifecycleQuery(c.walletId) }),
  idempotentBy: (c) => DepositMade.where({ [WalletTags.DEPOSIT_ID]: c.depositId }),
  decide: (wallet, c, _prepared, { now }) =>
    wallet.exists
      ? emit(DepositMade({ ...c, newBalance: wallet.balance + c.amount, depositedAt: now.toISOString() }, periodTags(c.walletId, wallet.period)))
      : fail(new WalletNotFound({ walletId: c.walletId }))
});
```

A command that only needs to commute with itself (a deposit) still conflicts with the closing of **its own period**; the framework adds that as a guard. A command that turns the period is strict for that call.
A refusal, a no-op or an idempotent repeat writes nothing of the turn.

## Test it with a clock

`given(...).at(date)` is the same scenario with the clock fixed at `date`; the log is shared, so a test walks through time.

<!-- file: examples/wallet-example-app/test/wallet-commands.test.ts#period-scenarios -->
```ts
test("the first deposit of the next month closes this month's statement and opens the next, carrying the balance", async () => {
  const s = given(opened("w1", 100));
  await s.at(new Date(Date.UTC(2026, 9, 31, 23, 59))).when(Deposit, dep("w1", "d1", 25));
  const r = await s.at(new Date(Date.UTC(2026, 10, 1, 0, 1))).when(Deposit, dep("w1", "d2", 5));
  expect(r.events.map((e) => e.type)).toEqual(["WalletStatementClosed", "WalletStatementOpened", "DepositMade"]);
  const [closed, opened2, deposit] = r.events;
  expect(closed!.data).toMatchObject({ month: 10, closingBalance: 125 });
  expect(opened2!.data).toMatchObject({ month: 11, openingBalance: 125 });
  expect(deposit!.data).toMatchObject({ newBalance: 130 });
});

test("a pod whose clock is still in October never turns the month back", async () => {
  const s = given(opened("w1", 0));
  await s.at(new Date(Date.UTC(2026, 10, 1, 0, 1))).when(Deposit, dep("w1", "d1", 5));
  const r = await s.at(new Date(Date.UTC(2026, 9, 31, 23, 59))).when(Deposit, dep("w1", "d2", 7));
  expect(r.events.map((e) => e.type)).toEqual(["DepositMade"]);
  expect(tags(r.events[0]!)).toMatchObject({ month: "11" });
});
```

To move the Effect clock in an integration test, wrap the command in a clock of your own (see `examples/wallet-example-app/test/support/clocked-commands.ts`) and build the event store with
`makeEventStoreLayer({ wakeupMode: "off" })`: the wake-up window measures time with that same clock, and a clock in the future makes it schedule a timer for days.

## What to know

- **A clock behind never turns a period back.** If another pod's clock says October and November is already open, the command decides in November; `crablet.period.clock_behind` counts it ([Monitor it](monitor-it.md)).
- **A period is turned once per entity.** An idle entity jumps straight to the current period: one closing, one opening. The turn reads every opening and closing the entity has ever had: 3 ms with 100 periods,
  9 ms with 1,000, 75 ms with 10,000 (`examples/wallet-example-app/diagnostics/period-tracking.diagnostic.ts`, one run), so months and days are comfortable for years and hours are not yet built.
- **It protects the commands that declare the period.** Something that writes events with the period's tags but does not use the model is not covered.
- The design, the algorithm and why the cursor must be the earliest horizon of the reads: [ADR-0025](../adr/0025-the-framework-turns-the-period.md) and [`period-rollover.md`](../plans/period-rollover.md).
