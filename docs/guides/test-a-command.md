# Test a command

A command is a pure decision, so you can test it with no database and no Docker. `given(...history)` builds an in-memory store holding that history, and
`.when(Command, input)` runs the **real** pipeline against it: input validation, the idempotency check, loading the model, `decide` and the conditional append.

[← Task guides](README.md)

## The shape of a test

<!-- file: examples/wallet-example-app/test/wallet-commands.test.ts#scenarios -->
```ts
test("lazily opens this month's statement, then records the deposit on it", async () => {
  const r = await given(opened("w1", 100)).when(Deposit, dep("w1", "d1", 25));
  expect(r.outcome).toBe("created");
  expect(r.events.map((e) => e.type)).toEqual(["WalletStatementOpened", "DepositMade"]);
  const [statement, deposit] = r.events;
  expect(statement!.data).toMatchObject({ openingBalance: 100 });
  expect(deposit!.data).toMatchObject({ amount: 25, newBalance: 125 });
  expect(tags(deposit!)).toMatchObject({ wallet_id: "w1", deposit_id: "d1", statement_id: tags(statement!)["statement_id"] });
});

test("a second deposit in the same month reuses the open statement", async () => {
  const s = given(opened("w1", 0));
  await s.when(Deposit, dep("w1", "d1"));
  const r = await s.when(Deposit, dep("w1", "d2", 5));
  expect(r.events.map((e) => e.type)).toEqual(["DepositMade"]);
  expect(r.events[0]!.data).toMatchObject({ newBalance: 15 });
});

test("an unknown wallet is WalletNotFound - and the statement it would have opened is not written", async () => {
  const s = given();
  const r = await s.when(Deposit, dep("ghost", "d1"));
  expect(r.error).toBeInstanceOf(WalletNotFound);
  expect(s.log).toEqual([]);
});

test("a repeated deposit id is an idempotent success and appends nothing", async () => {
  const s = given(opened("w1", 0));
  await s.when(Deposit, dep("w1", "d1"));
  const repeat = await s.when(Deposit, dep("w1", "d1"));
  expect(repeat.outcome).toBe("idempotent");
  expect(repeat.events).toEqual([]);
});
```

What you can assert on the result of `.when`:

- `outcome`: `"created"` (events were appended) or `"idempotent"` (the operation had already been done; nothing appended);
- `events`: the events that were appended, with `type`, `data` and `tags`;
- `error`: a domain error, `InvalidInput` for a bad payload, or `Duplicate` and `Conflict` from the append.

`given(...)` takes events; a scenario value can run several `when`s in a row, and `.log` is everything in the store afterwards (empty after a refusal, because a failed
command's changes are rolled back).

A `.when` that ends `"idempotent"` leaves the log as it was, `prepare`'s appends included: the real executor rolls that transaction back too (an idempotent result writes no audit row, so committing would leave events with no command behind them).

## What this does not cover

Concurrency: nothing interleaves in memory, so races and conflict retries are tested against Postgres only
(for example [`enrolment-guide-postgres.test.ts`](../../packages/commands/test/integration/enrolment-guide-postgres.test.ts)). The in-memory store and Postgres pass the
same conformance suite, so a scenario is a faithful stand-in for the rules, not for timing.

Run one file: `bun test examples/wallet-example-app/test/wallet-commands.test.ts`. More: [tutorial step 1](../tutorial/01-the-rule-in-memory.md),
[`@crablet/commands`](../../packages/commands/README.md).
