# Look something up before deciding

*Guide · developers whose command's input does not name the thing it decides on · the [tutorial](../../tutorial/README.md) step 1 · 10 minutes*

Usually the input names what a command decides on: `subscribe` gets a course id and a student id, and loads their models. Sometimes it does not. A library
member borrows a book with a **card number**, but the loan rules are about the **member** the card belongs to. The member has to be looked up before the
command can choose its model. That is what `resolve` is for.

The code on this page is `packages/commands/test/support/borrow-book.ts`, and the tests run exactly this.

## The events and the models

A card is issued to a member and can be cancelled; a loan is a fact about a member and a book.

<!-- file: packages/commands/test/support/borrow-book.ts#events -->
```ts
export const CardIssued = defineEvent("CardIssued", {
  schema: Schema.Struct({ cardNumber: Schema.String, memberId: Schema.String }),
  tags: (d) => ({ card_number: d.cardNumber })
});
export const CardCancelled = defineEvent("CardCancelled", {
  schema: Schema.Struct({ cardNumber: Schema.String }),
  tags: (d) => ({ card_number: d.cardNumber })
});
export const BookLent = defineEvent("BookLent", {
  schema: Schema.Struct({ memberId: Schema.String, bookId: Schema.String }),
  tags: (d) => ({ member_id: d.memberId, book_id: d.bookId })
});
```

<!-- file: packages/commands/test/support/borrow-book.ts#models -->
```ts
// Which member a card belongs to, or nobody once it is cancelled.
export const CardModel = defineModel({ by: "card_number", initial: () => ({ memberId: null as string | null }) })
  .on(CardIssued, (_, d) => ({ memberId: d.memberId }))
  .on(CardCancelled, () => ({ memberId: null }));

export const MemberModel = defineModel({ by: "member_id", initial: () => ({ loans: 0 }) }).on(BookLent, (m) => ({ loans: m.loans + 1 }));
export const BookModel = defineModel({ by: "book_id", initial: () => ({ lent: false }) }).on(BookLent, () => ({ lent: true }));
```

## The command

<!-- file: packages/commands/test/support/borrow-book.ts#command -->
```ts
export const BorrowBook = defineCommand({
  name: "borrow_book",
  input: Schema.Struct({ cardNumber: Schema.String, bookId: Schema.String }),
  errors: [CardNotValid, TooManyLoans, BookNotAvailable],
  // 1. Look the member up from the card. `read` can only read, and what it reads is protected: if the card is cancelled before the append, the append is refused
  //    and the command runs again, so the lookup finds the card cancelled.
  resolve: (c, read) => Effect.map(read.load(CardModel.of({ id: c.cardNumber })), (card) => card.memberId),
  // 2. Now the member is known, so the models can be chosen.
  model: (c, { resolved: memberId }) => all({ member: MemberModel.of({ id: memberId ?? "nobody" }), book: BookModel.of({ id: c.bookId }) }),
  decide: ({ member, book }, c, { resolved: memberId }) =>
    memberId === null
      ? fail(new CardNotValid({ cardNumber: c.cardNumber }))
      : member.loans >= MAX_LOANS
        ? fail(new TooManyLoans({ memberId, limit: MAX_LOANS }))
        : book.lent
          ? fail(new BookNotAvailable({ bookId: c.bookId }))
          : emit(BookLent({ memberId, bookId: c.bookId }))
});
```

Three things to notice:

- **`resolve` gets a reader, not the event store.** `read.load(model)` returns a model's state, and `read.exists(query)` answers whether anything matches. There is
  no `append`, so a lookup cannot write, and a write that sneaks into a lookup does not compile.
- **The result arrives by name.** What `resolve` returns is `resolved` in `model`, `consistency` and `decide`. The member is the card's, so `decide` can refuse
  a card that belongs to nobody (`memberId === null`) with a declared error.
- **What `resolve` reads is part of the command's condition.** The command decides on the member's loans and the book, and also on the card's events. If the card
  is cancelled after the lookup and before the append, the append is refused, the command runs again, and the second lookup finds no member: `CardNotValid`, not a
  book lent on a cancelled card.

## Test it

<!-- file: packages/commands/test/resolve-guide.test.ts#tests -->
```ts
  test("a valid card lends the book to the member it belongs to", async () => {
    const s = given(CardIssued({ cardNumber: "k1", memberId: "ann" }));
    const r = await s.when(BorrowBook, { cardNumber: "k1", bookId: "b1" });
    expect(r.outcome).toBe("created");
    expect(r.events.map((e) => e.data)).toEqual([{ memberId: "ann", bookId: "b1" }]);
  });

  test("a cancelled card, or one that was never issued, lends nothing", async () => {
    const cancelled = given(CardIssued({ cardNumber: "k1", memberId: "ann" }), CardCancelled({ cardNumber: "k1" }));
    expect((await cancelled.when(BorrowBook, { cardNumber: "k1", bookId: "b1" })).error).toBeInstanceOf(CardNotValid);
    expect((await given().when(BorrowBook, { cardNumber: "ghost", bookId: "b1" })).error).toBeInstanceOf(CardNotValid);
  });
```

`given(...)` runs the real pipeline, `resolve` included, against the in-memory store ([Test a command](./test-a-command.md)). What it cannot show is the race:
nothing interleaves in memory. The race, with the card cancelled between the lookup and the append, runs against Postgres in
`packages/commands/test/integration/resolve-lookup-postgres.test.ts`, with a barrier that forces the overlap; with the lookup left out of the condition, that test fails.

## When not to use it

- **When the model's id is in the input.** Do not add a lookup for what the input already names.
- **When the lookup key can be a tag of a model.** Often a lookup is itself a model, as `CardModel` is here; `resolve` is only for choosing the *next* model from its result.
- **To write.** `resolve` reads. Everything a command writes goes through `decide`, under the command's own condition.
- **To choose a period.** A model with a period (`.period`) that is only read in `resolve` is not turned: nothing closes the old period or opens the new one, so events tagged
  with it land in a period nobody opened. A command that writes into a period makes that model its own `model`.

The decision behind it, and what it replaced, is [ADR-0029](../../adr/0029-a-lookup-cannot-write-and-is-protected.md); the options are in the
[commands reference](../../reference/commands.md).
