// Nine of the ten examples on https://dcb.events/examples/ (unique username, invoice number, dynamic product price, opt-in token, product
// reviews, bike rental, library loans, event-sourced aggregate, prevent record duplication), written against this framework to see where
// the API fits and where it strains. In the examples' words each decision reads events by TAG and appends under the resulting condition.
// The tenth, course subscriptions, is the course enrolment app (examples/course-enrolment-app). Each is raced on Postgres in
// integration/dcb-examples-postgres.test.ts; course subscriptions in the app's integration/step2-postgres.test.ts.
import { createHash } from "node:crypto";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { defineCommand, emit, fail } from "../../src/Command.ts";
import { DomainError } from "../../src/Errors.ts";
import { defineEvent } from "../../src/Event.ts";
import { all, defineModel, type ModelInstance } from "../../src/Model.ts";
import { personal } from "../../src/Personal.ts";
import { afterLoad } from "./barrier.ts";

const MINUTE = 60_000;

// ---------------------------------------------------------------------------------------------
// 1. Unique username
// A username is a public handle used here as the uniqueness KEY, so it is the tag. Whether a handle counts as personal data is the
// app's call; if it does, tag an opaque key derived from it instead (see the sign-up example below) - tags cannot be erased.
// ---------------------------------------------------------------------------------------------
export const AccountRegistered = defineEvent("AccountRegistered", {
  schema: Schema.Struct({ username: Schema.String }),
  tags: (d) => ({ username: d.username.toLowerCase() }) // "jamesbond" and "JamesBond" are the same name
});
export const AccountClosed = defineEvent("AccountClosed", {
  schema: Schema.Struct({ username: Schema.String }),
  tags: (d) => ({ username: d.username.toLowerCase() })
});
// Two usernames on ONE event: a list value gives it the same `username` tag twice.
export const UsernameChanged = defineEvent("UsernameChanged", {
  schema: Schema.Struct({ oldUsername: Schema.String, newUsername: Schema.String }),
  tags: (d) => ({ username: [d.oldUsername.toLowerCase(), d.newUsername.toLowerCase()] })
});

export const RETENTION_MS = 3 * 24 * 60 * MINUTE;

// claimed: someone has it. releasedAt: when a closed/renamed-away name stops being reserved.
const UsernameModel = defineModel({
  by: "username",
  initial: () => ({ claimed: false, reservedUntil: 0 })
})
  .on(AccountRegistered, () => ({ claimed: true, reservedUntil: 0 }))
  .on(AccountClosed, (_, __, ctx) => ({ claimed: false, reservedUntil: ctx.event.occurredAt.getTime() + RETENTION_MS }))
  .on(UsernameChanged, (_, d, ctx) =>
    ctx.id === d.newUsername.toLowerCase()
      ? { claimed: true, reservedUntil: 0 }
      : { claimed: false, reservedUntil: ctx.event.occurredAt.getTime() + RETENTION_MS }
  );

export class UsernameClaimed extends DomainError("UsernameClaimed", { fields: { username: Schema.String }, kind: "conflict" }) {}

// `wait` (test-only) runs right after the model has loaded; see support/barrier.ts.
const registerAccount = (name: string, wait: Effect.Effect<void>) =>
  defineCommand({
    name,
    errors: [UsernameClaimed],
    // `now` is an input so the decision stays pure (and testable at any date)
    input: Schema.Struct({ username: Schema.String, now: Schema.Number }),
    model: (c) => afterLoad(UsernameModel.of({ id: c.username.toLowerCase() }), wait),
    decide: (name, c) => (name.claimed || c.now < name.reservedUntil ? fail(new UsernameClaimed({ username: c.username })) : emit(AccountRegistered(c)))
  });
export const RegisterAccount = registerAccount("register_account", Effect.void);
export const registerAccountWith = (wait: Effect.Effect<void>) => registerAccount("register_account_raced", wait);

// ---------------------------------------------------------------------------------------------
// 2. Invoice number: unique AND gap-free
// ---------------------------------------------------------------------------------------------
export const InvoiceCreated = defineEvent("InvoiceCreated", {
  schema: Schema.Struct({ invoiceNumber: Schema.Number, invoiceData: Schema.String }),
  // a model needs a key to bind by, even when the decision concerns "all invoices": a constant series tag
  tags: (d) => ({ invoice: d.invoiceNumber, series: "main" })
});
const InvoiceSeries = defineModel({ by: "series", initial: () => ({ next: 1 }) }).on(InvoiceCreated, (_, d) => ({ next: d.invoiceNumber + 1 }));

const createInvoice = (name: string, wait: Effect.Effect<void>, retries?: number) =>
  defineCommand({
    name,
    input: Schema.Struct({ invoiceData: Schema.String }),
    model: () => afterLoad(InvoiceSeries.of({ id: "main" }), wait),
    ...(retries !== undefined ? { retries } : {}),
    decide: (series, c) => emit(InvoiceCreated({ invoiceNumber: series.next, invoiceData: c.invoiceData }))
  });
export const CreateInvoice = createInvoice("create_invoice", Effect.void);
export const createInvoiceWith = (wait: Effect.Effect<void>, retries: number) => createInvoice("create_invoice_raced", wait, retries);

// ---------------------------------------------------------------------------------------------
// 3. Dynamic product price: an order is valid only at prices that were valid when displayed
// ---------------------------------------------------------------------------------------------
export const GRACE_MS = 10 * MINUTE;
export const ProductDefined = defineEvent("ProductDefined", {
  schema: Schema.Struct({ productId: Schema.String, price: Schema.Number }),
  tags: (d) => ({ product_id: d.productId })
});
export const ProductPriceChanged = defineEvent("ProductPriceChanged", {
  schema: Schema.Struct({ productId: Schema.String, newPrice: Schema.Number }),
  tags: (d) => ({ product_id: d.productId })
});
// One event, MANY products: a list value tags it product_id once per distinct product.
export const ProductsOrdered = defineEvent("ProductsOrdered", {
  schema: Schema.Struct({ items: Schema.Array(Schema.Struct({ productId: Schema.String, price: Schema.Number })) }),
  tags: (d) => ({ product_id: d.items.map((i) => i.productId) })
});

interface Price {
  readonly current: number | null;
  // prices that were replaced, and when
  readonly superseded: ReadonlyArray<{ readonly price: number; readonly at: number }>;
}
const ProductPrice = defineModel({ by: "product_id", initial: (): Price => ({ current: null, superseded: [] }) })
  .on(ProductDefined, (p, d) => ({ ...p, current: d.price }))
  .on(ProductPriceChanged, (p, d, ctx) => ({
    current: d.newPrice,
    superseded: p.current === null ? p.superseded : [...p.superseded, { price: p.current, at: ctx.event.occurredAt.getTime() }]
  }));

export class InvalidPrice extends DomainError("InvalidPrice", { fields: { productId: Schema.String }, kind: "conflict" }) {}

const priceIsValid = (p: Price, displayed: number, now: number) =>
  p.current === displayed || p.superseded.some((s) => s.price === displayed && now - s.at <= GRACE_MS);

const orderProducts = (name: string, wait: Effect.Effect<void>) =>
  defineCommand({
    name,
    errors: [InvalidPrice],
    input: Schema.Struct({
      items: Schema.Array(Schema.Struct({ productId: Schema.String, displayedPrice: Schema.Number })),
      now: Schema.Number
    }),
    // the set of products is only known at run time: one model per item, combined into one boundary
    model: (c) =>
      afterLoad(
        all(Object.fromEntries(c.items.map((i) => [i.productId, ProductPrice.of({ id: i.productId })])) as Record<string, ModelInstance<Price>>),
        wait
      ),
    decide: (prices, c) => {
      const bad = c.items.find((i) => !priceIsValid(prices[i.productId]!, i.displayedPrice, c.now));
      if (bad) return fail(new InvalidPrice({ productId: bad.productId }));
      return emit(ProductsOrdered({ items: c.items.map((i) => ({ productId: i.productId, price: i.displayedPrice })) }));
    }
  });
export const OrderProducts = orderProducts("order_products", Effect.void);
export const orderProductsWith = (wait: Effect.Effect<void>) => orderProducts("order_products_raced", wait);

export class ProductNotDefined extends DomainError("ProductNotDefined", { fields: { productId: Schema.String }, kind: "not_found" }) {}
export const ChangeProductPrice = defineCommand({
  name: "change_product_price",
  errors: [ProductNotDefined],
  input: Schema.Struct({ productId: Schema.String, newPrice: Schema.Number }),
  model: (c) => ProductPrice.of({ id: c.productId }),
  decide: (p, c) => (p.current === null ? fail(new ProductNotDefined({ productId: c.productId })) : emit(ProductPriceChanged(c)))
});

// ---------------------------------------------------------------------------------------------
// 4. Opt-in token: a one-time password confirms a sign-up once, within an hour
// ---------------------------------------------------------------------------------------------
export const TOKEN_TTL_MS = 60 * MINUTE;
// The email is personal data, so it is marked `personal` and is NOT a tag (tags are plain indexed text and cannot be erased):
// the events are found by an opaque key derived from it. `defineEvent` refuses a tag that equals a personal field's value.
const emailKey = (email: string): string => createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);
const signUpData = Schema.Struct({ email: personal(Schema.String), otp: Schema.String, name: personal(Schema.String) });
export const SignUpInitiated = defineEvent("SignUpInitiated", {
  schema: signUpData,
  tags: (d) => ({ email_key: emailKey(d.email), otp: d.otp })
});
export const SignUpConfirmed = defineEvent("SignUpConfirmed", {
  schema: signUpData,
  tags: (d) => ({ email_key: emailKey(d.email), otp: d.otp })
});
// bound by the email KEY, scoped to the one otp being confirmed
const PendingSignUp = defineModel({
  by: "email_key",
  initial: () => ({ initiatedAt: null as number | null, name: "", confirmed: false }),
  scope: (s: { otp: string }) => ({ otp: s.otp })
})
  .on(SignUpInitiated, (s, d, ctx) => ({ ...s, initiatedAt: ctx.event.occurredAt.getTime(), name: d.name }))
  .on(SignUpConfirmed, (s) => ({ ...s, confirmed: true }));

export class TokenInvalid extends DomainError("TokenInvalid", { fields: { reason: Schema.String }, kind: "invalid" }) {}

const confirmSignUp = (name: string, wait: Effect.Effect<void>) =>
  defineCommand({
  name,
  errors: [TokenInvalid],
  input: Schema.Struct({ email: personal(Schema.String), otp: Schema.String, now: Schema.Number }),
  model: (c) => afterLoad(PendingSignUp.of({ id: emailKey(c.email), otp: c.otp }), wait),
  decide: (s, c) =>
    s.initiatedAt === null
      ? fail(new TokenInvalid({ reason: "unknown" }))
      : s.confirmed
        ? fail(new TokenInvalid({ reason: "already used" }))
        : c.now - s.initiatedAt > TOKEN_TTL_MS
          ? fail(new TokenInvalid({ reason: "expired" }))
          : emit(SignUpConfirmed({ email: c.email, otp: c.otp, name: s.name }))
  });
export const ConfirmSignUp = confirmSignUp("confirm_sign_up", Effect.void);
export const confirmSignUpWith = (wait: Effect.Effect<void>) => confirmSignUp("confirm_sign_up_raced", wait);

// ---------------------------------------------------------------------------------------------
// 5. Product reviews: one review per customer and product, from a verified purchase, of a listed product
// No lookup table and no aggregate: each rule is a model bound by one tag and scoped by the other, so a review reads only the events of
// its customer AND product. Other customers' reviews, and the customer's other products, are outside its boundary.
// ---------------------------------------------------------------------------------------------
const review = Schema.Struct({
  productId: Schema.String,
  customerId: Schema.String,
  rating: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(5))
});
const product = Schema.Struct({ productId: Schema.String });
export const ProductReviewed = defineEvent("ProductReviewed", {
  schema: review,
  tags: (d) => ({ product_id: d.productId, customer_id: d.customerId })
});
// One order, many products: tagged with the customer and once per product, so "this customer bought this product" is a query for both.
export const OrderPlaced = defineEvent("OrderPlaced", {
  schema: Schema.Struct({ customerId: Schema.String, lines: Schema.Array(Schema.Struct({ productId: Schema.String, quantity: Schema.Int })) }),
  tags: (d) => ({ customer_id: d.customerId, product_id: d.lines.map((l) => l.productId) })
});
export const ProductDelisted = defineEvent("ProductDelisted", {
  schema: product,
  tags: (d) => ({ product_id: d.productId })
});

const ReviewedByCustomer = defineModel({ by: "product_id", initial: () => ({ reviewed: false }), scope: (s: { customerId: string }) => ({ customer_id: s.customerId }) })
  .on(ProductReviewed, () => ({ reviewed: true }));
const BoughtByCustomer = defineModel({ by: "customer_id", initial: () => ({ bought: false }), scope: (s: { productId: string }) => ({ product_id: s.productId }) })
  .on(OrderPlaced, () => ({ bought: true }));
const ProductListed = defineModel({ by: "product_id", initial: () => ({ listed: true }) }).on(ProductDelisted, () => ({ listed: false }));

export class ProductAlreadyReviewed extends DomainError("ProductAlreadyReviewed", { fields: { productId: Schema.String }, kind: "conflict" }) {}
export class NotBoughtByCustomer extends DomainError("NotBoughtByCustomer", { fields: { productId: Schema.String }, kind: "forbidden" }) {}
export class ProductWasDelisted extends DomainError("ProductWasDelisted", { fields: { productId: Schema.String }, kind: "conflict" }) {}

const reviewProduct = (name: string, wait: Effect.Effect<void>) =>
  defineCommand({
    name,
    errors: [ProductWasDelisted, NotBoughtByCustomer, ProductAlreadyReviewed],
    input: review,
    model: (c) =>
      afterLoad(
        all({
          product: ProductListed.of({ id: c.productId }),
          purchase: BoughtByCustomer.of({ id: c.customerId, productId: c.productId }),
          review: ReviewedByCustomer.of({ id: c.productId, customerId: c.customerId })
        }),
        wait
      ),
    // in the example's order: delisted, then not bought, then reviewed already
    decide: (m, c) =>
      !m.product.listed
        ? fail(new ProductWasDelisted({ productId: c.productId }))
        : !m.purchase.bought
          ? fail(new NotBoughtByCustomer({ productId: c.productId }))
          : m.review.reviewed
            ? fail(new ProductAlreadyReviewed({ productId: c.productId }))
            : emit(ProductReviewed(c))
  });
export const ReviewProduct = reviewProduct("review_product", Effect.void);
export const reviewProductWith = (wait: Effect.Effect<void>) => reviewProduct("review_product_raced", wait);

export const DelistProduct = defineCommand({
  name: "delist_product",
  errors: [ProductWasDelisted],
  input: product,
  model: (c) => ProductListed.of({ id: c.productId }),
  decide: (p, c) => (p.listed ? emit(ProductDelisted(c)) : fail(new ProductWasDelisted({ productId: c.productId })))
});

// ---------------------------------------------------------------------------------------------
// 6. Bike rental: a bike's lifecycle, and a member's limit of two bikes at a time
// Renting reads the bike and the member: its boundary is those two, so members renting different bikes do not affect each other, and one
// BikeRented counts for both. The example's BikeRentedByMember projection is the bike model's `rentedBy`: it reads the same events.
// ---------------------------------------------------------------------------------------------
const bike = Schema.Struct({ bikeId: Schema.String });
const rental = Schema.Struct({ bikeId: Schema.String, memberId: Schema.String });
export const BikeAddedToFleet = defineEvent("BikeAddedToFleet", { schema: bike, tags: (d) => ({ bike_id: d.bikeId }) });
export const BikeRented = defineEvent("BikeRented", { schema: rental, tags: (d) => ({ bike_id: d.bikeId, member_id: d.memberId }) });
export const BikeReturned = defineEvent("BikeReturned", { schema: rental, tags: (d) => ({ bike_id: d.bikeId, member_id: d.memberId }) });
export const BikeSentToRepair = defineEvent("BikeSentToRepair", { schema: bike, tags: (d) => ({ bike_id: d.bikeId }) });
export const BikeRepaired = defineEvent("BikeRepaired", { schema: bike, tags: (d) => ({ bike_id: d.bikeId }) });

export const MAX_RENTALS = 2;
type BikeStatus = "unknown" | "available" | "rented" | "in_repair";
const Bike = defineModel({ by: "bike_id", initial: () => ({ status: "unknown" as BikeStatus, rentedBy: null as string | null }) })
  .on(BikeAddedToFleet, () => ({ status: "available", rentedBy: null }))
  .on(BikeRented, (_, d) => ({ status: "rented", rentedBy: d.memberId }))
  .on(BikeReturned, () => ({ status: "available", rentedBy: null }))
  .on(BikeSentToRepair, () => ({ status: "in_repair", rentedBy: null }))
  .on(BikeRepaired, () => ({ status: "available", rentedBy: null }));
const MemberRentals = defineModel({ by: "member_id", initial: () => ({ active: 0 }) })
  .on(BikeRented, (m) => ({ active: m.active + 1 }))
  .on(BikeReturned, (m) => ({ active: m.active - 1 }));

export class BikeAlreadyInFleet extends DomainError("BikeAlreadyInFleet", { fields: { bikeId: Schema.String }, kind: "conflict" }) {}
export class BikeNotAvailable extends DomainError("BikeNotAvailable", { fields: { bikeId: Schema.String }, kind: "conflict" }) {}
export class BikeNotInRepair extends DomainError("BikeNotInRepair", { fields: { bikeId: Schema.String }, kind: "conflict" }) {}
export class RentalLimitReached extends DomainError("RentalLimitReached", { fields: { memberId: Schema.String }, kind: "conflict" }) {}
export class BikeNotRented extends DomainError("BikeNotRented", { fields: { bikeId: Schema.String }, kind: "conflict" }) {}
export class BikeRentedByAnotherMember extends DomainError("BikeRentedByAnotherMember", { fields: { bikeId: Schema.String }, kind: "forbidden" }) {}

export const AddBikeToFleet = defineCommand({
  name: "add_bike_to_fleet",
  errors: [BikeAlreadyInFleet],
  input: bike,
  model: (c) => Bike.of({ id: c.bikeId }),
  decide: (b, c) => (b.status === "unknown" ? emit(BikeAddedToFleet(c)) : fail(new BikeAlreadyInFleet(c)))
});
export const SendBikeToRepair = defineCommand({
  name: "send_bike_to_repair",
  errors: [BikeNotAvailable],
  input: bike,
  model: (c) => Bike.of({ id: c.bikeId }),
  decide: (b, c) => (b.status === "available" ? emit(BikeSentToRepair(c)) : fail(new BikeNotAvailable(c)))
});
export const RepairBike = defineCommand({
  name: "repair_bike",
  errors: [BikeNotInRepair],
  input: bike,
  model: (c) => Bike.of({ id: c.bikeId }),
  decide: (b, c) => (b.status === "in_repair" ? emit(BikeRepaired(c)) : fail(new BikeNotInRepair(c)))
});

const rentBike = (name: string, wait: Effect.Effect<void>) =>
  defineCommand({
    name,
    errors: [BikeNotAvailable, RentalLimitReached],
    input: rental,
    model: (c) => afterLoad(all({ bike: Bike.of({ id: c.bikeId }), member: MemberRentals.of({ id: c.memberId }) }), wait),
    decide: (m, c) =>
      m.bike.status !== "available"
        ? fail(new BikeNotAvailable({ bikeId: c.bikeId }))
        : m.member.active >= MAX_RENTALS
          ? fail(new RentalLimitReached({ memberId: c.memberId }))
          : emit(BikeRented(c))
  });
export const RentBike = rentBike("rent_bike", Effect.void);
export const rentBikeWith = (wait: Effect.Effect<void>) => rentBike("rent_bike_raced", wait);

// A damaged bike goes to repair in the same append as its return: no moment where it is available.
export const ReturnBike = defineCommand({
  name: "return_bike",
  errors: [BikeNotRented, BikeRentedByAnotherMember],
  input: Schema.Struct({ bikeId: Schema.String, memberId: Schema.String, damaged: Schema.Boolean }),
  model: (c) => Bike.of({ id: c.bikeId }),
  decide: (b, c) => {
    if (b.status !== "rented") return fail(new BikeNotRented({ bikeId: c.bikeId }));
    if (b.rentedBy !== c.memberId) return fail(new BikeRentedByAnotherMember({ bikeId: c.bikeId }));
    const returned = BikeReturned({ bikeId: c.bikeId, memberId: c.memberId });
    return c.damaged ? emit(returned, BikeSentToRepair({ bikeId: c.bikeId })) : emit(returned);
  }
});

// ---------------------------------------------------------------------------------------------
// 7. Library loans: copies of a book are lent, returned and renewed; members are suspended; books are reserved
// Each rule reads only what it is about: lending reads the copy and the member's loans, a suspension only the member's suspensions, a
// reservation only the book's reservations. Renewing is the two-step case: the copy says who borrowed it and of which book, and only then
// are the borrower's suspension and the book's reservations known. That first step is `resolve`, and what it read joins the condition.
// ---------------------------------------------------------------------------------------------
const copy = Schema.Struct({ copyId: Schema.String });
const loan = Schema.Struct({ copyId: Schema.String, memberId: Schema.String });
const member = Schema.Struct({ memberId: Schema.String });
const reservation = Schema.Struct({ bookId: Schema.String, memberId: Schema.String });
export const CopyAddedToCatalog = defineEvent("CopyAddedToCatalog", {
  schema: Schema.Struct({ copyId: Schema.String, bookId: Schema.String }),
  tags: (d) => ({ copy_id: d.copyId, book_id: d.bookId })
});
export const CopyLent = defineEvent("CopyLent", { schema: loan, tags: (d) => ({ copy_id: d.copyId, member_id: d.memberId }) });
export const CopyReturned = defineEvent("CopyReturned", { schema: loan, tags: (d) => ({ copy_id: d.copyId, member_id: d.memberId }) });
export const LoanRenewed = defineEvent("LoanRenewed", { schema: copy, tags: (d) => ({ copy_id: d.copyId }) });
export const MemberSuspended = defineEvent("MemberSuspended", { schema: member, tags: (d) => ({ member_id: d.memberId }) });
export const MemberReinstated = defineEvent("MemberReinstated", { schema: member, tags: (d) => ({ member_id: d.memberId }) });
export const BookReserved = defineEvent("BookReserved", { schema: reservation, tags: (d) => ({ book_id: d.bookId, member_id: d.memberId }) });
export const ReservationCancelled = defineEvent("ReservationCancelled", {
  schema: reservation,
  tags: (d) => ({ book_id: d.bookId, member_id: d.memberId })
});

export const MAX_COPIES = 3;
export const MAX_RENEWALS = 2;
// the example's CopyInCatalog, CopyBookId, CopyBorrowerId and CopyRenewals: they read the same events, so they are one model
const Copy = defineModel({
  by: "copy_id",
  initial: () => ({ inCatalog: false, bookId: null as string | null, borrowerId: null as string | null, renewals: 0 })
})
  .on(CopyAddedToCatalog, (c, d) => ({ ...c, inCatalog: true, bookId: d.bookId }))
  .on(CopyLent, (c, d) => ({ ...c, borrowerId: d.memberId, renewals: 0 }))
  .on(CopyReturned, (c) => ({ ...c, borrowerId: null }))
  .on(LoanRenewed, (c) => ({ ...c, renewals: c.renewals + 1 }));
const MemberLoanCount = defineModel({ by: "member_id", initial: () => ({ loans: 0 }) })
  .on(CopyLent, (m) => ({ loans: m.loans + 1 }))
  .on(CopyReturned, (m) => ({ loans: m.loans - 1 }));
const MemberIsSuspended = defineModel({ by: "member_id", initial: () => ({ suspended: false }) })
  .on(MemberSuspended, () => ({ suspended: true }))
  .on(MemberReinstated, () => ({ suspended: false }));
const BookReservations = defineModel({ by: "book_id", initial: () => ({ members: [] as ReadonlyArray<string> }) })
  .on(BookReserved, (b, d) => ({ members: [...b.members, d.memberId] }))
  .on(ReservationCancelled, (b, d) => ({ members: b.members.filter((m) => m !== d.memberId) }));

export class CopyAlreadyInCatalog extends DomainError("CopyAlreadyInCatalog", { fields: { copyId: Schema.String }, kind: "conflict" }) {}
export class CopyNotInCatalog extends DomainError("CopyNotInCatalog", { fields: { copyId: Schema.String }, kind: "not_found" }) {}
export class CopyNotAvailable extends DomainError("CopyNotAvailable", { fields: { copyId: Schema.String }, kind: "conflict" }) {}
export class CopyLimitReached extends DomainError("CopyLimitReached", { fields: { memberId: Schema.String }, kind: "conflict" }) {}
export class CopyNotLent extends DomainError("CopyNotLent", { fields: { copyId: Schema.String }, kind: "conflict" }) {}
export class CopyLentToAnotherMember extends DomainError("CopyLentToAnotherMember", { fields: { copyId: Schema.String }, kind: "forbidden" }) {}
export class LoanRenewedTwice extends DomainError("LoanRenewedTwice", { fields: { copyId: Schema.String }, kind: "conflict" }) {}
export class BorrowerSuspended extends DomainError("BorrowerSuspended", { fields: { memberId: Schema.String }, kind: "forbidden" }) {}
export class BookIsReserved extends DomainError("BookIsReserved", { fields: { bookId: Schema.String }, kind: "conflict" }) {}
export class MemberAlreadySuspended extends DomainError("MemberAlreadySuspended", { fields: { memberId: Schema.String }, kind: "conflict" }) {}
export class MemberNotSuspended extends DomainError("MemberNotSuspended", { fields: { memberId: Schema.String }, kind: "conflict" }) {}
export class BookAlreadyReserved extends DomainError("BookAlreadyReserved", { fields: { bookId: Schema.String }, kind: "conflict" }) {}
export class BookNotReserved extends DomainError("BookNotReserved", { fields: { bookId: Schema.String }, kind: "conflict" }) {}

export const AddCopyToCatalog = defineCommand({
  name: "add_copy_to_catalog",
  errors: [CopyAlreadyInCatalog],
  input: Schema.Struct({ copyId: Schema.String, bookId: Schema.String }),
  model: (c) => Copy.of({ id: c.copyId }),
  decide: (copy, c) => (copy.inCatalog ? fail(new CopyAlreadyInCatalog({ copyId: c.copyId })) : emit(CopyAddedToCatalog(c)))
});

const lendCopy = (name: string, wait: Effect.Effect<void>) =>
  defineCommand({
    name,
    errors: [CopyNotInCatalog, CopyNotAvailable, CopyLimitReached],
    input: loan,
    model: (c) => afterLoad(all({ copy: Copy.of({ id: c.copyId }), member: MemberLoanCount.of({ id: c.memberId }) }), wait),
    decide: (m, c) =>
      !m.copy.inCatalog
        ? fail(new CopyNotInCatalog({ copyId: c.copyId }))
        : m.copy.borrowerId !== null
          ? fail(new CopyNotAvailable({ copyId: c.copyId }))
          : m.member.loans >= MAX_COPIES
            ? fail(new CopyLimitReached({ memberId: c.memberId }))
            : emit(CopyLent(c))
  });
export const LendCopy = lendCopy("lend_copy", Effect.void);
export const lendCopyWith = (wait: Effect.Effect<void>) => lendCopy("lend_copy_raced", wait);

export const ReturnCopy = defineCommand({
  name: "return_copy",
  errors: [CopyNotLent, CopyLentToAnotherMember],
  input: loan,
  model: (c) => Copy.of({ id: c.copyId }),
  decide: (copy, c) =>
    copy.borrowerId === null
      ? fail(new CopyNotLent({ copyId: c.copyId }))
      : copy.borrowerId !== c.memberId
        ? fail(new CopyLentToAnotherMember({ copyId: c.copyId }))
        : emit(CopyReturned(c))
});

const renewLoan = (name: string, wait: Effect.Effect<void>) =>
  defineCommand({
    name,
    errors: [CopyNotLent, LoanRenewedTwice, BorrowerSuspended, BookIsReserved],
    input: copy,
    // 1. the copy says who borrowed it and of which book
    resolve: (c, read) => Effect.map(read.load(Copy.of({ id: c.copyId })), (copy) => ({ borrowerId: copy.borrowerId, bookId: copy.bookId })),
    // 2. then the borrower's suspensions and the book's reservations can be read. The copy is read again for its renewals: the lookup
    //    answers the question of which models, the model answers the decision.
    model: (c, { resolved }) =>
      afterLoad(
        all({
          copy: Copy.of({ id: c.copyId }),
          borrower: MemberIsSuspended.of({ id: resolved.borrowerId ?? "nobody" }),
          book: BookReservations.of({ id: resolved.bookId ?? "none" })
        }),
        wait
      ),
    decide: (m, c) =>
      m.copy.borrowerId === null
        ? fail(new CopyNotLent({ copyId: c.copyId }))
        : m.copy.renewals >= MAX_RENEWALS
          ? fail(new LoanRenewedTwice({ copyId: c.copyId }))
          : m.borrower.suspended
            ? fail(new BorrowerSuspended({ memberId: m.copy.borrowerId }))
            : m.book.members.some((r) => r !== m.copy.borrowerId)
              ? fail(new BookIsReserved({ bookId: m.copy.bookId! }))
              : emit(LoanRenewed(c))
  });
export const RenewLoan = renewLoan("renew_loan", Effect.void);
export const renewLoanWith = (wait: Effect.Effect<void>) => renewLoan("renew_loan_raced", wait);

export const SuspendMember = defineCommand({
  name: "suspend_member",
  errors: [MemberAlreadySuspended],
  input: member,
  model: (c) => MemberIsSuspended.of({ id: c.memberId }),
  decide: (m, c) => (m.suspended ? fail(new MemberAlreadySuspended(c)) : emit(MemberSuspended(c)))
});
export const ReinstateMember = defineCommand({
  name: "reinstate_member",
  errors: [MemberNotSuspended],
  input: member,
  model: (c) => MemberIsSuspended.of({ id: c.memberId }),
  decide: (m, c) => (m.suspended ? emit(MemberReinstated(c)) : fail(new MemberNotSuspended(c)))
});
export const ReserveBook = defineCommand({
  name: "reserve_book",
  errors: [BookAlreadyReserved],
  input: reservation,
  model: (c) => BookReservations.of({ id: c.bookId }),
  decide: (b, c) => (b.members.includes(c.memberId) ? fail(new BookAlreadyReserved({ bookId: c.bookId })) : emit(BookReserved(c)))
});
export const CancelReservation = defineCommand({
  name: "cancel_reservation",
  errors: [BookNotReserved],
  input: reservation,
  model: (c) => BookReservations.of({ id: c.bookId }),
  decide: (b, c) => (b.members.includes(c.memberId) ? emit(ReservationCancelled(c)) : fail(new BookNotReserved({ bookId: c.bookId })))
});

// ---------------------------------------------------------------------------------------------
// 8. Event-sourced aggregate: a course as one aggregate, on a DCB store
// The classic aggregate is the special case of one model, bound by the aggregate's tag, that handles every event of the aggregate. Its
// fold is the aggregate's `reconstitute`, the cursor the executor carries is the aggregate's version, and the append under the model's
// condition is the repository's "fail if anything for this aggregate was stored after my version". What changes from the DCB examples
// is the size of the boundary: every command on the course conflicts with every other, even a capacity change with a subscription.
// ---------------------------------------------------------------------------------------------
export const CourseDefined = defineEvent("CourseDefined", {
  schema: Schema.Struct({ courseId: Schema.String, title: Schema.String, capacity: Schema.Int }),
  tags: (d) => ({ course: d.courseId })
});
export const CourseCapacityChanged = defineEvent("CourseCapacityChanged", {
  schema: Schema.Struct({ courseId: Schema.String, newCapacity: Schema.Int }),
  tags: (d) => ({ course: d.courseId })
});
export const StudentSubscribedToCourse = defineEvent("StudentSubscribedToCourse", {
  schema: Schema.Struct({ courseId: Schema.String, studentId: Schema.String }),
  tags: (d) => ({ course: d.courseId })
});

const CourseAggregate = defineModel({ by: "course", initial: () => ({ defined: false, capacity: 0, subscriptions: 0 }) })
  .on(CourseDefined, (_, d) => ({ defined: true, capacity: d.capacity, subscriptions: 0 }))
  .on(CourseCapacityChanged, (c, d) => ({ ...c, capacity: d.newCapacity }))
  .on(StudentSubscribedToCourse, (c) => ({ ...c, subscriptions: c.subscriptions + 1 }));

export class CourseAlreadyDefined extends DomainError("CourseAlreadyDefined", { fields: { courseId: Schema.String }, kind: "conflict" }) {}
export class CourseNotDefined extends DomainError("CourseNotDefined", { fields: { courseId: Schema.String }, kind: "not_found" }) {}
export class CapacityUnchanged extends DomainError("CapacityUnchanged", { fields: { courseId: Schema.String }, kind: "invalid" }) {}
export class CapacityBelowSubscriptions extends DomainError("CapacityBelowSubscriptions", {
  fields: { courseId: Schema.String, subscriptions: Schema.Int },
  kind: "conflict"
}) {}
export class CourseFullyBooked extends DomainError("CourseFullyBooked", { fields: { courseId: Schema.String }, kind: "conflict" }) {}

const course = (courseId: string, wait: Effect.Effect<void>) => afterLoad(CourseAggregate.of({ id: courseId }), wait);

export const DefineCourse = defineCommand({
  name: "define_course",
  errors: [CourseAlreadyDefined],
  input: Schema.Struct({ courseId: Schema.String, title: Schema.String, capacity: Schema.Int }),
  model: (c) => CourseAggregate.of({ id: c.courseId }),
  decide: (course, c) => (course.defined ? fail(new CourseAlreadyDefined({ courseId: c.courseId })) : emit(CourseDefined(c)))
});

const changeCourseCapacity = (name: string, wait: Effect.Effect<void>) =>
  defineCommand({
    name,
    errors: [CourseNotDefined, CapacityUnchanged, CapacityBelowSubscriptions],
    input: Schema.Struct({ courseId: Schema.String, newCapacity: Schema.Int }),
    model: (c) => course(c.courseId, wait),
    decide: (course, c) =>
      !course.defined
        ? fail(new CourseNotDefined({ courseId: c.courseId }))
        : course.capacity === c.newCapacity
          ? fail(new CapacityUnchanged({ courseId: c.courseId }))
          : c.newCapacity < course.subscriptions
            ? fail(new CapacityBelowSubscriptions({ courseId: c.courseId, subscriptions: course.subscriptions }))
            : emit(CourseCapacityChanged(c))
  });
export const ChangeCourseCapacity = changeCourseCapacity("change_course_capacity", Effect.void);
export const changeCourseCapacityWith = (wait: Effect.Effect<void>) => changeCourseCapacity("change_course_capacity_raced", wait);

const subscribeStudentToCourse = (name: string, wait: Effect.Effect<void>) =>
  defineCommand({
    name,
    errors: [CourseNotDefined, CourseFullyBooked],
    input: Schema.Struct({ courseId: Schema.String, studentId: Schema.String }),
    model: (c) => course(c.courseId, wait),
    decide: (course, c) =>
      !course.defined
        ? fail(new CourseNotDefined({ courseId: c.courseId }))
        : course.subscriptions >= course.capacity
          ? fail(new CourseFullyBooked({ courseId: c.courseId }))
          : emit(StudentSubscribedToCourse(c))
  });
export const SubscribeStudentToCourse = subscribeStudentToCourse("subscribe_student_to_course", Effect.void);
export const subscribeStudentToCourseWith = (wait: Effect.Effect<void>) => subscribeStudentToCourse("subscribe_student_to_course_raced", wait);

// ---------------------------------------------------------------------------------------------
// 9. Prevent record duplication: an order placed twice with one idempotency token is placed once
// The example's rule, as written: a used token is refused. `idempotentBy` is the framework's own answer to the same problem, and it
// answers the same request again with the first outcome instead of an error, and a different order under a used token with
// IdempotencyMismatch (ADR-0034, ADR-0035); both are here.
// The example's event is OrderPlaced; that name is the product reviews' order, so this one is PurchaseOrderPlaced.
// ---------------------------------------------------------------------------------------------
const purchaseOrder = Schema.Struct({ orderId: Schema.String, idempotencyToken: Schema.String });
export const PurchaseOrderPlaced = defineEvent("PurchaseOrderPlaced", {
  schema: purchaseOrder,
  tags: (d) => ({ order_id: d.orderId, idempotency_token: d.idempotencyToken })
});
const IdempotencyTokenWasUsed = defineModel({ by: "idempotency_token", initial: () => ({ used: false }) }).on(PurchaseOrderPlaced, () => ({
  used: true
}));

export class OrderAlreadyPlaced extends DomainError("OrderAlreadyPlaced", { fields: { idempotencyToken: Schema.String }, kind: "conflict" }) {}

const placeOrder = (name: string, wait: Effect.Effect<void>) =>
  defineCommand({
    name,
    errors: [OrderAlreadyPlaced],
    input: purchaseOrder,
    model: (c) => afterLoad(IdempotencyTokenWasUsed.of({ id: c.idempotencyToken }), wait),
    decide: (token, c) => (token.used ? fail(new OrderAlreadyPlaced({ idempotencyToken: c.idempotencyToken })) : emit(PurchaseOrderPlaced(c)))
  });
export const PlaceOrder = placeOrder("place_order", Effect.void);
export const placeOrderWith = (wait: Effect.Effect<void>) => placeOrder("place_order_raced", wait);

// The same, with the framework's idempotency: the model is not needed, and a repeat is "already done", not an error.
export const PlaceOrderIdempotent = defineCommand({
  name: "place_order_idempotent",
  input: purchaseOrder,
  idempotentBy: (c) => PurchaseOrderPlaced.where({ idempotency_token: c.idempotencyToken }),
  decide: (_, c) => emit(PurchaseOrderPlaced(c))
});
