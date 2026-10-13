// The "look something up first" guide's example (docs/guides/build/look-something-up-first.md): a library where a member borrows a book with a CARD NUMBER.
// The input names the card, but the loan rules are about the member the card belongs to, so the command looks the member up (`resolve`) before it chooses its model.
// Shared by the in-memory test (resolve-guide.test.ts) and the Postgres race (integration/resolve-lookup-postgres.test.ts). The code in the regions is what the guide shows.
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { defineCommand, emit, fail } from "../../src/Command.ts";
import { DomainError } from "../../src/Errors.ts";
import { defineEvent } from "../../src/Event.ts";
import { all, defineModel } from "../../src/Model.ts";

// #region events
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
// #endregion events

// #region models
// Which member a card belongs to, or nobody once it is cancelled.
export const CardModel = defineModel({ by: "card_number", initial: () => ({ memberId: null as string | null }) })
  .on(CardIssued, (_, d) => ({ memberId: d.memberId }))
  .on(CardCancelled, () => ({ memberId: null }));

export const MemberModel = defineModel({ by: "member_id", initial: () => ({ loans: 0 }) }).on(BookLent, (m) => ({ loans: m.loans + 1 }));
export const BookModel = defineModel({ by: "book_id", initial: () => ({ lent: false }) }).on(BookLent, () => ({ lent: true }));
// #endregion models

export const MAX_LOANS = 3;

export class CardNotValid extends DomainError("CardNotValid", { fields: { cardNumber: Schema.String }, kind: "invalid" }) {}
export class TooManyLoans extends DomainError("TooManyLoans", { fields: { memberId: Schema.String, limit: Schema.Int }, kind: "conflict" }) {}
export class BookNotAvailable extends DomainError("BookNotAvailable", { fields: { bookId: Schema.String }, kind: "conflict" }) {}

// #region command
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
// #endregion command
