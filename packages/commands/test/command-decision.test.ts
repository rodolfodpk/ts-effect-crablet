import { describe, expect, test } from "bun:test";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import * as LogPosition from "@crablet/eventstore/LogPosition";
import * as Query from "@crablet/eventstore/Query";
import { commutative, withIdempotencyQuery, withLifecycleGuard } from "../src/CommandDecision.ts";

const ev = (type: string) => AppendEvent.ofUntagged(type, {});

describe("CommandDecision", () => {
  test("an idempotency query with nothing in it is refused: it would match nothing, and every repeat would append again", () => {
    expect(() => withIdempotencyQuery(commutative(ev("A")), Query.noCondition())).toThrow("idempotency query must not be empty");
    expect(withIdempotencyQuery(commutative(ev("A")), Query.forEvent("A")).condition.idempotencyQuery).toEqual(Query.forEvent("A"));
  });

  test("a lifecycle guard takes one event or a list", () => {
    expect(withLifecycleGuard(ev("Deposited"), Query.forEvent("Opened"), LogPosition.zero()).events).toEqual([ev("Deposited")]);
  });

  test("a lifecycle guard over a type it appends is refused, naming each such type once, sorted", () => {
    const guard = Query.of([Query.queryItemOf(["B", "Opened", "A"], []), Query.queryItemOf(["B"], [])]);
    expect(() => withLifecycleGuard([ev("A"), ev("B")], guard, LogPosition.zero())).toThrow(
      "Lifecycle guard query must not include appended event types: A, B"
    );
  });

  test("a lifecycle guard on every event (Query.all) is refused: it includes the types the command appends", () => {
    expect(() => withLifecycleGuard([ev("A")], Query.all(), LogPosition.zero())).toThrow(/cannot be Query.all\(\)/);
  });
});
