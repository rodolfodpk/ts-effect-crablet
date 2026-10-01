// The four examples from https://dcb.events/examples/ (unique username, invoice number, dynamic product
// price, opt-in token), written against this framework to see where the API fits and where it strains.
// In the examples' words each decision reads events by TAG and appends under the resulting condition.
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

export const OrderProducts = defineCommand({
  name: "order_products",
  errors: [InvalidPrice],
  input: Schema.Struct({
    items: Schema.Array(Schema.Struct({ productId: Schema.String, displayedPrice: Schema.Number })),
    now: Schema.Number
  }),
  // the set of products is only known at run time: one model per item, combined into one boundary
  model: (c) =>
    all(Object.fromEntries(c.items.map((i) => [i.productId, ProductPrice.of({ id: i.productId })])) as Record<string, ModelInstance<Price>>),
  decide: (prices, c) => {
    const bad = c.items.find((i) => !priceIsValid(prices[i.productId]!, i.displayedPrice, c.now));
    if (bad) return fail(new InvalidPrice({ productId: bad.productId }));
    return emit(ProductsOrdered({ items: c.items.map((i) => ({ productId: i.productId, price: i.displayedPrice })) }));
  }
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
