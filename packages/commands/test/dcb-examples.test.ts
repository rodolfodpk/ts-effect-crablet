// The dcb.events examples against this framework, with no database (see support/dcb-examples.ts).
import { describe, expect, test } from "bun:test";
import { IdempotencyMismatch } from "../src/Errors.ts";
import { given } from "../src/testing/Scenario.ts";
import {
  AccountClosed,
  AccountRegistered,
  AddBikeToFleet,
  BikeAddedToFleet,
  BikeAlreadyInFleet,
  BikeNotAvailable,
  BikeNotInRepair,
  BikeNotRented,
  BikeRented,
  BikeRentedByAnotherMember,
  BikeRepaired,
  BikeReturned,
  BikeSentToRepair,
  DelistProduct,
  NotBoughtByCustomer,
  OrderPlaced,
  ProductAlreadyReviewed,
  ProductDelisted,
  ProductReviewed,
  ProductWasDelisted,
  RentBike,
  RentalLimitReached,
  RepairBike,
  ReturnBike,
  ReviewProduct,
  SendBikeToRepair,
  ConfirmSignUp,
  CreateInvoice,
  GRACE_MS,
  InvalidPrice,
  OrderProducts,
  ProductDefined,
  ProductPriceChanged,
  RETENTION_MS,
  RegisterAccount,
  SignUpConfirmed,
  SignUpInitiated,
  TOKEN_TTL_MS,
  TokenInvalid,
  UsernameChanged,
  UsernameClaimed,
  AddCopyToCatalog,
  BookAlreadyReserved,
  BookIsReserved,
  BookNotReserved,
  BookReserved,
  BorrowerSuspended,
  CancelReservation,
  CapacityBelowSubscriptions,
  CapacityUnchanged,
  ChangeCourseCapacity,
  ChangeProductPrice,
  CopyAddedToCatalog,
  CopyAlreadyInCatalog,
  CopyLent,
  CopyLentToAnotherMember,
  CopyLimitReached,
  CopyNotAvailable,
  CopyNotInCatalog,
  CopyNotLent,
  CopyReturned,
  CourseAlreadyDefined,
  CourseDefined,
  CourseFullyBooked,
  CourseNotDefined,
  DefineCourse,
  LendCopy,
  LoanRenewed,
  LoanRenewedTwice,
  MemberAlreadySuspended,
  MemberNotSuspended,
  MemberReinstated,
  MemberSuspended,
  OrderAlreadyPlaced,
  PlaceOrder,
  PlaceOrderIdempotent,
  ProductNotDefined,
  PurchaseOrderPlaced,
  ReinstateMember,
  RenewLoan,
  ReservationCancelled,
  ReserveBook,
  ReturnCopy,
  StudentSubscribedToCourse,
  SubscribeStudentToCourse,
  SuspendMember
} from "./support/dcb-examples.ts";

const now = () => Date.now();

describe("unique username", () => {
  test("a claimed name is refused, whatever its case; other names are free", async () => {
    const s = given();
    expect((await s.when(RegisterAccount, { username: "jamesbond", now: now() })).outcome).toBe("created");
    expect((await s.when(RegisterAccount, { username: "JamesBond", now: now() })).error).toBeInstanceOf(UsernameClaimed);
    expect((await s.when(RegisterAccount, { username: "moneypenny", now: now() })).outcome).toBe("created");
  });

  test("a closed account's name stays reserved for 3 days, then is free", async () => {
    const s = given(AccountRegistered({ username: "q" }), AccountClosed({ username: "q" }));
    expect((await s.when(RegisterAccount, { username: "q", now: now() })).error).toBeInstanceOf(UsernameClaimed);
    expect((await s.when(RegisterAccount, { username: "q", now: now() + RETENTION_MS + 1000 })).outcome).toBe("created");
  });

  test("renaming claims the new name and reserves the old one (one event, two usernames)", async () => {
    const s = given(AccountRegistered({ username: "old" }), UsernameChanged({ oldUsername: "old", newUsername: "new" }));
    expect((await s.when(RegisterAccount, { username: "new", now: now() })).error).toBeInstanceOf(UsernameClaimed);
    expect((await s.when(RegisterAccount, { username: "old", now: now() })).error).toBeInstanceOf(UsernameClaimed); // reserved
    expect((await s.when(RegisterAccount, { username: "old", now: now() + RETENTION_MS + 1000 })).outcome).toBe("created");
  });
});

describe("invoice number (unique and gap-free)", () => {
  test("numbers are consecutive from 1", async () => {
    const s = given();
    for (const n of [1, 2, 3]) {
      const r = await s.when(CreateInvoice, { invoiceData: `inv ${n}` });
      expect((r.events[0]!.data as { invoiceNumber: number }).invoiceNumber).toBe(n);
    }
  });
});

describe("dynamic product price", () => {
  const defined = () => given(ProductDefined({ productId: "p1", price: 10 }), ProductDefined({ productId: "p2", price: 20 }));
  const order = (items: Array<[string, number]>, at = now()) => ({ items: items.map(([productId, displayedPrice]) => ({ productId, displayedPrice })), now: at });

  test("an order at the current prices of several products is one event tagged with every product", async () => {
    const r = await defined().when(OrderProducts, order([["p1", 10], ["p2", 20]]));
    expect(r.outcome).toBe("created");
    expect(r.events[0]!.tags.filter((t) => t.key === "product_id").map((t) => t.value).sort()).toEqual(["p1", "p2"]);
  });

  test("a price that was never valid is refused, naming the product", async () => {
    const r = await defined().when(OrderProducts, order([["p1", 10], ["p2", 19]]));
    expect((r.error as InvalidPrice)._tag).toBe("InvalidPrice");
    expect((r.error as InvalidPrice).productId).toBe("p2");
  });

  test("after a price change the old price is valid for the grace period only", async () => {
    const s = defined();
    s.store.seed(ProductPriceChanged({ productId: "p1", newPrice: 12 }));
    expect((await s.when(OrderProducts, order([["p1", 10]]))).outcome).toBe("created"); // within grace
    expect((await s.when(OrderProducts, order([["p1", 10]], now() + GRACE_MS + 1000))).error).toBeInstanceOf(InvalidPrice);
    expect((await s.when(OrderProducts, order([["p1", 12]], now() + GRACE_MS + 1000))).outcome).toBe("created"); // the new price
  });

  test("a price changes only for a defined product", async () => {
    expect((await defined().when(ChangeProductPrice, { productId: "p1", newPrice: 12 })).events.map((e) => e.data)).toEqual([{ productId: "p1", newPrice: 12 }]);
    expect((await given().when(ChangeProductPrice, { productId: "p1", newPrice: 12 })).error).toBeInstanceOf(ProductNotDefined);
  });
});

describe("opt-in token", () => {
  const initiated = () => SignUpInitiated({ email: "Ann@Example.com", otp: "123456", name: "Ann" });
  const confirm = (otp: string, at = now()) => ({ email: "ann@example.com", otp, now: at });

  test("the right token confirms once; a second use is refused", async () => {
    const s = given(initiated());
    expect((await s.when(ConfirmSignUp, confirm("123456"))).outcome).toBe("created");
    expect(((await s.when(ConfirmSignUp, confirm("123456"))).error as TokenInvalid).reason).toBe("already used");
  });

  test("a wrong token is unknown; an expired one is refused", async () => {
    const s = given(initiated());
    expect(((await s.when(ConfirmSignUp, confirm("000000"))).error as TokenInvalid).reason).toBe("unknown");
    expect(((await s.when(ConfirmSignUp, confirm("123456", now() + TOKEN_TTL_MS + 1000))).error as TokenInvalid).reason).toBe("expired");
  });

  test("confirming one token does not use up another token of the same email", async () => {
    const s = given(initiated(), SignUpInitiated({ email: "ann@example.com", otp: "999999", name: "Ann" }), SignUpConfirmed({ email: "ann@example.com", otp: "999999", name: "Ann" }));
    expect((await s.when(ConfirmSignUp, confirm("123456"))).outcome).toBe("created");
  });
});

// The scenarios of https://dcb.events/examples/product-reviews/ (features 2 and 3: a verified purchase, a listed product), by their names there.
describe("product reviews", () => {
  const bought = (customerId: string, ...products: Array<[string, number]>) =>
    OrderPlaced({ customerId, lines: products.map(([productId, quantity]) => ({ productId, quantity })) });
  const review = (productId: string, customerId: string, rating = 5) => ({ productId, customerId, rating });

  test("review a product twice: refused", async () => {
    const r = await given(bought("c1", ["p1", 1]), ProductReviewed(review("p1", "c1", 4))).when(ReviewProduct, review("p1", "c1"));
    expect(r.error).toBeInstanceOf(ProductAlreadyReviewed);
  });

  test("review a product another customer has reviewed", async () => {
    const r = await given(bought("c1", ["p1", 1]), ProductReviewed(review("p1", "c2", 4))).when(ReviewProduct, review("p1", "c1"));
    expect(r.outcome).toBe("created");
    expect(r.events.map((e) => [e.type, e.data])).toEqual([["ProductReviewed", review("p1", "c1")]]);
  });

  test("review another product", async () => {
    const r = await given(bought("c1", ["p1", 1], ["p2", 2]), ProductReviewed(review("p2", "c1", 4))).when(ReviewProduct, review("p1", "c1"));
    expect(r.outcome).toBe("created");
  });

  test("review a product that was not bought, or that only another customer bought: refused", async () => {
    expect((await given().when(ReviewProduct, review("p1", "c1"))).error).toBeInstanceOf(NotBoughtByCustomer);
    expect((await given(bought("c2", ["p1", 1])).when(ReviewProduct, review("p1", "c1"))).error).toBeInstanceOf(NotBoughtByCustomer);
  });

  test("review a product the customer bought with other products", async () => {
    expect((await given(bought("c1", ["p2", 1], ["p1", 3])).when(ReviewProduct, review("p1", "c1"))).outcome).toBe("created");
  });

  test("review a delisted product: refused, before the other checks", async () => {
    expect((await given(bought("c1", ["p1", 1]), ProductDelisted({ productId: "p1" })).when(ReviewProduct, review("p1", "c1"))).error).toBeInstanceOf(ProductWasDelisted);
    expect((await given(ProductDelisted({ productId: "p1" })).when(ReviewProduct, review("p1", "c1"))).error).toBeInstanceOf(ProductWasDelisted);
  });

  test("a rating outside 1 to 5 is invalid input", async () => {
    expect((await given(bought("c1", ["p1", 1])).when(ReviewProduct, review("p1", "c1", 6))).error?._tag).toBe("InvalidInput");
  });

  test("delist a product twice: refused; delist a product that was reviewed", async () => {
    expect((await given(ProductDelisted({ productId: "p1" })).when(DelistProduct, { productId: "p1" })).error).toBeInstanceOf(ProductWasDelisted);
    expect((await given(ProductReviewed(review("p1", "c1", 4))).when(DelistProduct, { productId: "p1" })).outcome).toBe("created");
  });

  test("a review is tagged with its product and its customer, the two tags its boundary reads it by", async () => {
    const r = await given(bought("c1", ["p1", 1])).when(ReviewProduct, review("p1", "c1"));
    expect(r.events[0]!.tags.map((t) => `${t.key}=${t.value}`).sort()).toEqual(["customer_id=c1", "product_id=p1"]);
  });
});

// The scenarios of https://dcb.events/examples/bike-rental/ (the last version of each command), by their names there.
describe("bike rental", () => {
  const added = (...bikes: Array<string>) => bikes.map((bikeId) => BikeAddedToFleet({ bikeId }));
  const rented = (bikeId: string, memberId: string) => BikeRented({ bikeId, memberId });

  test("a bike joins the fleet once", async () => {
    expect((await given().when(AddBikeToFleet, { bikeId: "b1" })).outcome).toBe("created");
    expect((await given(...added("b1")).when(AddBikeToFleet, { bikeId: "b1" })).error).toBeInstanceOf(BikeAlreadyInFleet);
  });

  test("rent an available bike; not one that is rented, in repair, or not in the fleet; a repaired one again", async () => {
    expect((await given(...added("b1")).when(RentBike, { bikeId: "b1", memberId: "m1" })).events.map((e) => e.type)).toEqual(["BikeRented"]);
    expect((await given(...added("b1"), rented("b1", "m2")).when(RentBike, { bikeId: "b1", memberId: "m1" })).error).toBeInstanceOf(BikeNotAvailable);
    expect((await given(...added("b1"), BikeSentToRepair({ bikeId: "b1" })).when(RentBike, { bikeId: "b1", memberId: "m1" })).error).toBeInstanceOf(BikeNotAvailable);
    expect((await given().when(RentBike, { bikeId: "b1", memberId: "m1" })).error).toBeInstanceOf(BikeNotAvailable);
    const repaired = given(...added("b1"), BikeSentToRepair({ bikeId: "b1" }), BikeRepaired({ bikeId: "b1" }));
    expect((await repaired.when(RentBike, { bikeId: "b1", memberId: "m1" })).outcome).toBe("created");
  });

  test("rent a third bike: refused; rent a bike after returning one", async () => {
    const two = [...added("b1", "b2", "b3"), rented("b1", "m1"), rented("b2", "m1")];
    expect((await given(...two).when(RentBike, { bikeId: "b3", memberId: "m1" })).error).toBeInstanceOf(RentalLimitReached);
    expect((await given(...two, BikeReturned({ bikeId: "b1", memberId: "m1" })).when(RentBike, { bikeId: "b3", memberId: "m1" })).outcome).toBe("created");
    expect((await given(...two).when(RentBike, { bikeId: "b3", memberId: "m2" })).outcome).toBe("created"); // another member's limit is their own
  });

  test("return a bike rented by another member: refused; return a rented bike", async () => {
    const r = given(...added("b1"), rented("b1", "m2"));
    expect((await r.when(ReturnBike, { bikeId: "b1", memberId: "m1", damaged: false })).error).toBeInstanceOf(BikeRentedByAnotherMember);
    const own = await given(...added("b1"), rented("b1", "m1")).when(ReturnBike, { bikeId: "b1", memberId: "m1", damaged: false });
    expect(own.events.map((e) => [e.type, e.data])).toEqual([["BikeReturned", { bikeId: "b1", memberId: "m1" }]]);
    expect((await given(...added("b1")).when(ReturnBike, { bikeId: "b1", memberId: "m1", damaged: false })).error).toBeInstanceOf(BikeNotRented);
  });

  test("return a damaged bike: returned and sent to repair in one append, so it cannot be rented until repaired", async () => {
    const s = given(...added("b1"), rented("b1", "m1"));
    const r = await s.when(ReturnBike, { bikeId: "b1", memberId: "m1", damaged: true });
    expect(r.events.map((e) => e.type)).toEqual(["BikeReturned", "BikeSentToRepair"]);
    expect((await s.when(RentBike, { bikeId: "b1", memberId: "m2" })).error).toBeInstanceOf(BikeNotAvailable);
    expect((await s.when(RepairBike, { bikeId: "b1" })).outcome).toBe("created");
    expect((await s.when(RentBike, { bikeId: "b1", memberId: "m2" })).outcome).toBe("created");
  });

  test("send a rented bike to repair: refused; repair only a bike in repair", async () => {
    expect((await given(...added("b1"), rented("b1", "m1")).when(SendBikeToRepair, { bikeId: "b1" })).error).toBeInstanceOf(BikeNotAvailable);
    expect((await given(...added("b1")).when(RepairBike, { bikeId: "b1" })).error).toBeInstanceOf(BikeNotInRepair);
  });
});

// The scenarios of https://dcb.events/examples/library-loans/, by their names there (the page has none for the other commands; they are
// the last two tests).
describe("library loans", () => {
  const cataloged = (...copies: Array<[string, string]>) => copies.map(([copyId, bookId]) => CopyAddedToCatalog({ copyId, bookId }));
  const lent = (copyId: string, memberId: string) => CopyLent({ copyId, memberId });
  const returned = (copyId: string, memberId: string) => CopyReturned({ copyId, memberId });
  const c1 = cataloged(["c1", "book1"]);

  test("Lend an available copy; Lend a copy that is not in the catalog; Lend a copy that is lent; Lend a returned copy", async () => {
    expect((await given(...c1).when(LendCopy, { copyId: "c1", memberId: "m1" })).events.map((e) => e.type)).toEqual(["CopyLent"]);
    expect((await given().when(LendCopy, { copyId: "c1", memberId: "m1" })).error).toBeInstanceOf(CopyNotInCatalog);
    expect((await given(...c1, lent("c1", "m2")).when(LendCopy, { copyId: "c1", memberId: "m1" })).error).toBeInstanceOf(CopyNotAvailable);
    expect((await given(...c1, lent("c1", "m2"), returned("c1", "m2")).when(LendCopy, { copyId: "c1", memberId: "m1" })).outcome).toBe("created");
  });

  test("Lend a fourth copy: refused; a returned one does not count", async () => {
    const three = [...cataloged(["c1", "b1"], ["c2", "b2"], ["c3", "b3"], ["c4", "b4"]), lent("c1", "m1"), lent("c2", "m1"), lent("c3", "m1")];
    expect((await given(...three).when(LendCopy, { copyId: "c4", memberId: "m1" })).error).toBeInstanceOf(CopyLimitReached);
    expect((await given(...three, returned("c1", "m1")).when(LendCopy, { copyId: "c4", memberId: "m1" })).outcome).toBe("created");
  });

  test("Return a lent copy; Return a copy that is not lent; Return a copy lent to another member", async () => {
    expect((await given(...c1, lent("c1", "m1")).when(ReturnCopy, { copyId: "c1", memberId: "m1" })).events.map((e) => e.type)).toEqual(["CopyReturned"]);
    expect((await given(...c1).when(ReturnCopy, { copyId: "c1", memberId: "m1" })).error).toBeInstanceOf(CopyNotLent);
    expect((await given(...c1, lent("c1", "m2")).when(ReturnCopy, { copyId: "c1", memberId: "m1" })).error).toBeInstanceOf(CopyLentToAnotherMember);
  });

  test("Renew a loan; Renew a copy that is not lent; Renew a loan a third time; Renew a copy that was lent again", async () => {
    const loan = [...c1, lent("c1", "m1")];
    expect((await given(...loan).when(RenewLoan, { copyId: "c1" })).events.map((e) => e.type)).toEqual(["LoanRenewed"]);
    expect((await given(...c1).when(RenewLoan, { copyId: "c1" })).error).toBeInstanceOf(CopyNotLent);
    const twice = [...loan, LoanRenewed({ copyId: "c1" }), LoanRenewed({ copyId: "c1" })];
    expect((await given(...twice).when(RenewLoan, { copyId: "c1" })).error).toBeInstanceOf(LoanRenewedTwice);
    expect((await given(...twice, returned("c1", "m1"), lent("c1", "m2")).when(RenewLoan, { copyId: "c1" })).outcome).toBe("created");
  });

  test("Renew a loan of a suspended member; Renew a loan while another member is suspended", async () => {
    const loan = [...c1, lent("c1", "m1")];
    const r = await given(...loan, MemberSuspended({ memberId: "m1" })).when(RenewLoan, { copyId: "c1" });
    expect((r.error as BorrowerSuspended).memberId).toBe("m1");
    expect((await given(...loan, MemberSuspended({ memberId: "m2" })).when(RenewLoan, { copyId: "c1" })).outcome).toBe("created");
    expect((await given(...loan, MemberSuspended({ memberId: "m1" }), MemberReinstated({ memberId: "m1" })).when(RenewLoan, { copyId: "c1" })).outcome).toBe("created");
  });

  test("Renew a loan of a reserved book; after the reservation was cancelled; while another book is reserved", async () => {
    const loan = [...cataloged(["c1", "book1"], ["c2", "book2"]), lent("c1", "m1")];
    const reserved = BookReserved({ bookId: "book1", memberId: "m2" });
    expect((await given(...loan, reserved).when(RenewLoan, { copyId: "c1" })).error).toBeInstanceOf(BookIsReserved);
    expect((await given(...loan, reserved, ReservationCancelled({ bookId: "book1", memberId: "m2" })).when(RenewLoan, { copyId: "c1" })).outcome).toBe("created");
    expect((await given(...loan, BookReserved({ bookId: "book2", memberId: "m2" })).when(RenewLoan, { copyId: "c1" })).outcome).toBe("created");
  });

  test("a copy joins the catalog once; a member is suspended once and reinstated only when suspended", async () => {
    expect((await given().when(AddCopyToCatalog, { copyId: "c1", bookId: "book1" })).outcome).toBe("created");
    expect((await given(...c1).when(AddCopyToCatalog, { copyId: "c1", bookId: "book1" })).error).toBeInstanceOf(CopyAlreadyInCatalog);
    const s = given();
    expect((await s.when(SuspendMember, { memberId: "m1" })).outcome).toBe("created");
    expect((await s.when(SuspendMember, { memberId: "m1" })).error).toBeInstanceOf(MemberAlreadySuspended);
    expect((await s.when(ReinstateMember, { memberId: "m1" })).outcome).toBe("created");
    expect((await s.when(ReinstateMember, { memberId: "m1" })).error).toBeInstanceOf(MemberNotSuspended);
  });

  test("a member reserves a book once and cancels only their own reservation", async () => {
    const s = given();
    expect((await s.when(ReserveBook, { bookId: "book1", memberId: "m1" })).outcome).toBe("created");
    expect((await s.when(ReserveBook, { bookId: "book1", memberId: "m1" })).error).toBeInstanceOf(BookAlreadyReserved);
    expect((await s.when(ReserveBook, { bookId: "book1", memberId: "m2" })).outcome).toBe("created");
    expect((await s.when(CancelReservation, { bookId: "book1", memberId: "m3" })).error).toBeInstanceOf(BookNotReserved);
    expect((await s.when(CancelReservation, { bookId: "book1", memberId: "m1" })).outcome).toBe("created");
  });
});

// https://dcb.events/examples/event-sourced-aggregate/ has no scenarios; these are its three rules, and what the aggregate's version means.
describe("event-sourced aggregate", () => {
  const defined = (capacity: number, subscribed = 0) => [
    CourseDefined({ courseId: "c1", title: "Course 01", capacity }),
    ...Array.from({ length: subscribed }, (_, i) => StudentSubscribedToCourse({ courseId: "c1", studentId: `s${i}` }))
  ];

  test("a course is defined once; a command on a course that is not defined is refused", async () => {
    expect((await given().when(DefineCourse, { courseId: "c1", title: "Course 01", capacity: 10 })).outcome).toBe("created");
    expect((await given(...defined(10)).when(DefineCourse, { courseId: "c1", title: "Course 01", capacity: 10 })).error).toBeInstanceOf(CourseAlreadyDefined);
    expect((await given().when(ChangeCourseCapacity, { courseId: "c1", newCapacity: 5 })).error).toBeInstanceOf(CourseNotDefined);
    expect((await given().when(SubscribeStudentToCourse, { courseId: "c1", studentId: "s1" })).error).toBeInstanceOf(CourseNotDefined);
  });

  test("a capacity change to the current capacity is refused; one below the subscriptions too; others are recorded", async () => {
    expect((await given(...defined(10)).when(ChangeCourseCapacity, { courseId: "c1", newCapacity: 15 })).outcome).toBe("created");
    expect((await given(...defined(10)).when(ChangeCourseCapacity, { courseId: "c1", newCapacity: 10 })).error).toBeInstanceOf(CapacityUnchanged);
    const below = await given(...defined(2, 2)).when(ChangeCourseCapacity, { courseId: "c1", newCapacity: 1 });
    expect((below.error as CapacityBelowSubscriptions).subscriptions).toBe(2);
    expect((await given(...defined(2, 2)).when(ChangeCourseCapacity, { courseId: "c1", newCapacity: 3 })).outcome).toBe("created");
  });

  test("a student cannot subscribe to a fully booked course; a raised capacity makes room", async () => {
    expect((await given(...defined(2, 1)).when(SubscribeStudentToCourse, { courseId: "c1", studentId: "s9" })).outcome).toBe("created");
    const s = given(...defined(1, 1));
    expect((await s.when(SubscribeStudentToCourse, { courseId: "c1", studentId: "s9" })).error).toBeInstanceOf(CourseFullyBooked);
    await s.when(ChangeCourseCapacity, { courseId: "c1", newCapacity: 2 });
    expect((await s.when(SubscribeStudentToCourse, { courseId: "c1", studentId: "s9" })).outcome).toBe("created");
  });
});

// The scenarios of https://dcb.events/examples/prevent-record-duplication/, then the same with `idempotentBy`.
describe("prevent record duplication", () => {
  const placed = PurchaseOrderPlaced({ orderId: "o1", idempotencyToken: "t1" });

  test("an order with a token that was used is refused; with a new token it is placed", async () => {
    expect((await given(placed).when(PlaceOrder, { orderId: "o2", idempotencyToken: "t1" })).error).toBeInstanceOf(OrderAlreadyPlaced);
    const r = await given(placed).when(PlaceOrder, { orderId: "o2", idempotencyToken: "t2" });
    expect(r.events.map((e) => [e.type, e.data])).toEqual([["PurchaseOrderPlaced", { orderId: "o2", idempotencyToken: "t2" }]]);
  });

  test("with idempotentBy, the same request again is 'already done', not an error; another order with its token is refused", async () => {
    const s = given();
    const request = { orderId: "o1", idempotencyToken: "t1" };
    expect((await s.when(PlaceOrderIdempotent, request)).outcome).toBe("created");
    const again = await s.when(PlaceOrderIdempotent, request);
    expect(again.outcome).toBe("idempotent");
    expect(again.events).toEqual([]);
    expect((await s.when(PlaceOrderIdempotent, { orderId: "o2", idempotencyToken: "t1" })).error).toBeInstanceOf(IdempotencyMismatch);
  });
});
