// The dcb.events examples against this framework, with no database (see support/dcb-examples.ts).
import { describe, expect, test } from "bun:test";
import { given } from "../src/testing/Scenario.ts";
import {
  AccountClosed,
  AccountRegistered,
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
  UsernameClaimed
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
