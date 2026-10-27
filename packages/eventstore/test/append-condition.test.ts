import { describe, expect, test } from "bun:test";
import * as AppendCondition from "../src/AppendCondition.ts";
import * as LogPosition from "../src/LogPosition.ts";
import * as Query from "../src/Query.ts";

const at = LogPosition.of(5n, new Date(0), "9");
const model = Query.forEvent("A");

describe("AppendCondition", () => {
  test("of: a concurrency check, and no idempotency check unless one is given", () => {
    expect(AppendCondition.of(at, model)).toEqual({ afterPosition: at, concurrencyQuery: model, idempotencyQuery: Query.noCondition() });
    const key = Query.forEventAndTag("Paid", "payment_id", "p1");
    expect(AppendCondition.of(at, model, key).idempotencyQuery).toBe(key);
  });

  test("idempotent and idempotentFromQuery: only an idempotency check, from the start of the log", () => {
    const none = { afterPosition: LogPosition.zero(), concurrencyQuery: Query.noCondition() };
    expect(AppendCondition.idempotent("Paid", "Payment_ID", "p1")).toEqual({ ...none, idempotencyQuery: Query.forEventAndTag("Paid", "payment_id", "p1") });
    expect(AppendCondition.idempotentFromQuery(model)).toEqual({ ...none, idempotencyQuery: model });
  });

  test("empty: no check at all", () => {
    expect(AppendCondition.empty()).toEqual({ afterPosition: LogPosition.zero(), concurrencyQuery: Query.noCondition(), idempotencyQuery: Query.noCondition() });
  });

  test("failIfChanged(model).after(position): the concurrency check of a decision model read up to that position", () => {
    expect(AppendCondition.failIfChanged(model).after(at)).toEqual({ afterPosition: at, concurrencyQuery: model, idempotencyQuery: Query.noCondition() });
  });
});
