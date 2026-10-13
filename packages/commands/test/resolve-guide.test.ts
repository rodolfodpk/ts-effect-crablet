// The "look something up first" guide's example with no database (in-memory store, real command pipeline).
import { describe, expect, test } from "bun:test";
import { given } from "../src/testing/Scenario.ts";
import { BookLent, BookNotAvailable, BorrowBook, CardCancelled, CardIssued, CardNotValid, MAX_LOANS, TooManyLoans } from "./support/borrow-book.ts";

describe("borrow_book", () => {
  // #region tests
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
  // #endregion tests

  test("the member's loan limit and the book's availability are decided on the member the card resolved to", async () => {
    const loans = Array.from({ length: MAX_LOANS }, (_, i) => BookLent({ memberId: "ann", bookId: `old-${i}` }));
    const s = given(CardIssued({ cardNumber: "k1", memberId: "ann" }), CardIssued({ cardNumber: "k2", memberId: "bob" }), ...loans);
    expect((await s.when(BorrowBook, { cardNumber: "k1", bookId: "b1" })).error).toBeInstanceOf(TooManyLoans);
    expect((await s.when(BorrowBook, { cardNumber: "k2", bookId: "b1" })).outcome).toBe("created");
    expect((await s.when(BorrowBook, { cardNumber: "k2", bookId: "b1" })).error).toBeInstanceOf(BookNotAvailable);
  });
});
