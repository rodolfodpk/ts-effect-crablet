import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import * as Tag from "@crablet/eventstore/Tag";
import * as Query from "@crablet/eventstore/Query";
import { defineEvent } from "../src/Event.ts";

const DepositMade = defineEvent("DepositMade", {
  schema: Schema.Struct({
    walletId: Schema.String,
    depositId: Schema.String,
    amount: Schema.Number,
    note: Schema.optional(Schema.String)
  }),
  tags: (d) => ({ wallet_id: d.walletId, deposit_id: d.depositId, amount_band: d.amount > 100 ? "large" : undefined })
});

describe("defineEvent", () => {
  test("building an event sets the type, the payload, and the tags derived from it", () => {
    const event = DepositMade({ walletId: "w1", depositId: "d1", amount: 5 });
    expect(event.type).toBe("DepositMade");
    expect(event.eventData).toEqual({ walletId: "w1", depositId: "d1", amount: 5 });
    expect(event.tags).toEqual([Tag.of("wallet_id", "w1"), Tag.of("deposit_id", "d1")]);
  });

  test("tags with a null/undefined value are skipped; numbers become strings; keys are lower-cased", () => {
    const Numbered = defineEvent("Numbered", {
      schema: Schema.Struct({ n: Schema.Number }),
      tags: (d) => ({ Seq: d.n, absent: null, missing: undefined })
    });
    expect(Numbered({ n: 7 }).tags).toEqual([{ key: "seq", value: "7" }]);
    // a derived tag is only present when the payload gives it a value
    expect(DepositMade({ walletId: "w", depositId: "d", amount: 500 }).tags.map((t) => t.key)).toContain("amount_band");
  });

  test("extra tags are appended after the derived ones", () => {
    const event = DepositMade({ walletId: "w1", depositId: "d1", amount: 5 }, [Tag.of("year", "2026")]);
    expect(event.tags.map((t) => `${t.key}=${t.value}`)).toEqual(["wallet_id=w1", "deposit_id=d1", "year=2026"]);
  });

  test("the event type is exposed as a literal for use as a key", () => {
    const type: "DepositMade" = DepositMade.type;
    expect(type).toBe("DepositMade");
  });

  test("decode narrows valid stored data and throws on data that does not match the schema", () => {
    expect(DepositMade.decode({ walletId: "w1", depositId: "d1", amount: 5 }).amount).toBe(5);
    expect(() => DepositMade.decode({ walletId: "w1" })).toThrow();
    expect(() => DepositMade.decode({ walletId: "w1", depositId: "d1", amount: "5" })).toThrow();
  });

  test("where() builds a query for the type, restricted to the given tag values", () => {
    expect(DepositMade.where({ deposit_id: "d1" })).toEqual(Query.forEventAndTags("DepositMade", [Tag.of("deposit_id", "d1")]));
    expect(DepositMade.where({ wallet_id: "w1", deposit_id: "d1" })).toEqual(
      Query.forEventAndTags("DepositMade", [Tag.of("wallet_id", "w1"), Tag.of("deposit_id", "d1")])
    );
    // no filter: every event of the type
    expect(DepositMade.where()).toEqual(Query.forEvent("DepositMade"));
    // an undefined filter value is ignored
    expect(DepositMade.where({ wallet_id: undefined })).toEqual(Query.forEvent("DepositMade"));
  });

  test("where() only accepts tag keys the event declares (checked by the type checker)", () => {
    // @ts-expect-error - "dposit_id" is not one of DepositMade's tags
    DepositMade.where({ dposit_id: "d1" });
    expect(true).toBe(true);
  });
});
