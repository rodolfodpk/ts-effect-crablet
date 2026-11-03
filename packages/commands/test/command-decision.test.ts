import { describe, expect, test } from "bun:test";
import * as AppendEvent from "@crablet/eventstore/AppendEvent";
import * as LogPosition from "@crablet/eventstore/LogPosition";
import * as Query from "@crablet/eventstore/Query";
import * as ReadSnapshot from "@crablet/eventstore/ReadSnapshot";
import { commutative, nonCommutative, withIdempotencyQuery, withLifecycleGuard } from "../src/CommandDecision.ts";

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

  test("what the reads could see goes into the condition when they carried it, and nothing is added when they did not (ADR-0048)", () => {
    const seen = ReadSnapshot.fromText("10:40:12");
    expect(nonCommutative(ev("A"), Query.forEvent("A"), LogPosition.zero(), seen).condition.seen).toBe(seen);
    expect(withLifecycleGuard(ev("A"), Query.forEvent("Opened"), LogPosition.zero(), seen).condition.seen).toBe(seen);
    expect("seen" in nonCommutative(ev("A"), Query.forEvent("A"), LogPosition.zero()).condition).toBe(false);
    expect("seen" in withLifecycleGuard(ev("A"), Query.forEvent("Opened"), LogPosition.zero()).condition).toBe(false);
  });
});
